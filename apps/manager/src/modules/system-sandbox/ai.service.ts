import {
  DEFAULT_SYSTEM_MODEL_CONFIG,
  SYSTEM_MODEL_CONFIG_PATH,
  type SystemModelAction,
  type SystemModelConfig,
  type SystemModelRef,
} from "@frak/atelier-shared/constants";
import type { Workspace } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { withRetry } from "../../shared/lib/retry.ts";
import type { ConfigFileService } from "../config-file/index.ts";
import type { SystemSandboxService } from "./system-sandbox.service.ts";

const log = createChildLogger("system-ai");

const MAX_TITLE_LENGTH = 80;

const GENERATION_RETRY = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 2000,
} as const;
type DescriptionTrigger = "created" | "updated";

interface PromptOptions {
  agent?: string;
  text: string;
  label: string;
  model?: { providerID: string; modelID: string };
}

export class SystemAiService {
  constructor(
    private readonly systemSandbox: SystemSandboxService,
    private readonly configFileService: ConfigFileService,
  ) {}

  getModelConfig(): SystemModelConfig {
    const configFile = this.configFileService.getByPath(
      SYSTEM_MODEL_CONFIG_PATH,
      "global",
    );

    if (!configFile) {
      return DEFAULT_SYSTEM_MODEL_CONFIG;
    }

    try {
      return JSON.parse(configFile.content) as SystemModelConfig;
    } catch {
      log.warn("Failed to parse system model config, using defaults");
      return DEFAULT_SYSTEM_MODEL_CONFIG;
    }
  }

  setModelConfig(config: SystemModelConfig): void {
    this.configFileService.upsert(
      undefined,
      SYSTEM_MODEL_CONFIG_PATH,
      JSON.stringify(config, null, 2),
      "json",
    );
  }

  resolveModel(
    action: SystemModelAction,
  ): { providerID: string; modelID: string } | undefined {
    const config = this.getModelConfig();
    const actionModel: SystemModelRef | null = config[action];
    if (actionModel) return actionModel;
    if (config.default) return config.default;
    return undefined;
  }

  fallbackTitle(description: string): string {
    const trimmed = description.trim();
    if (trimmed.length <= MAX_TITLE_LENGTH) return trimmed;

    const truncated = trimmed.slice(0, MAX_TITLE_LENGTH);
    const lastSpace = truncated.lastIndexOf(" ");
    return lastSpace > 40
      ? `${truncated.slice(0, lastSpace)}...`
      : `${truncated}...`;
  }

  generateTitleInBackground(
    description: string,
    onTitle: (title: string) => void,
  ): void {
    this.runInBackground(
      {
        agent: "title",
        text: description,
        label: "title",
        model: this.resolveModel("title"),
      },
      onTitle,
      (title) => {
        if (title.length > MAX_TITLE_LENGTH) {
          throw new Error(`Title too long (${title.length} chars), retrying`);
        }
        return title;
      },
    );
  }

  generateDescriptionInBackground(
    workspace: Workspace,
    trigger: DescriptionTrigger,
    onDescription: (description: string) => void,
  ): void {
    this.runInBackground(
      {
        agent: "description",
        text: this.buildDescriptionPrompt(workspace, trigger),
        label: "description",
        model: this.resolveModel("description"),
      },
      onDescription,
    );
  }

  private runInBackground(
    options: PromptOptions,
    onResult: (text: string) => void,
    validate?: (result: string) => string,
  ): void {
    setImmediate(() => {
      withRetry(
        async () => {
          const result = await this.promptOpenCode(options);
          return validate ? validate(result) : result;
        },
        { ...GENERATION_RETRY, label: options.label },
      )
        .then(onResult)
        .catch((error) => {
          log.warn(
            { error, label: options.label },
            `Background ${options.label} generation failed after retries`,
          );
        });
    });
  }

  private async promptOpenCode(options: PromptOptions): Promise<string> {
    const { client } = await this.systemSandbox.acquire();

    try {
      const { data: session, error: createError } =
        await client.session.create();
      if (createError || !session?.id) {
        log.error({ createError }, "Failed to create opencode session");
        throw new Error(
          `Failed to create opencode session for ${options.label}`,
        );
      }

      try {
        const { data, error: promptError } = await client.session.prompt({
          sessionID: session.id,
          ...(options.agent && { agent: options.agent }),
          ...(options.model && { model: options.model }),
          parts: [{ type: "text", text: options.text }],
        });

        if (promptError || !data) {
          log.error({ promptError }, `${options.label} prompt returned error`);
          throw new Error(`${options.label} prompt failed`);
        }

        if (data.info?.error) {
          log.error(
            { assistantError: data.info.error },
            `${options.label} LLM error`,
          );
          throw new Error(
            `${options.label} error: ${data.info.error.name} - ${JSON.stringify(data.info.error.data)}`,
          );
        }

        const textPart = data.parts.find((p) => p.type === "text");
        if (!textPart || textPart.type !== "text" || !textPart.text.trim()) {
          log.error(
            {
              partTypes: data.parts.map((p) => p.type),
              partCount: data.parts.length,
              info: {
                modelID: data.info?.modelID,
                providerID: data.info?.providerID,
                finish: data.info?.finish,
              },
            },
            `No text part in ${options.label} response`,
          );
          throw new Error(`No text in ${options.label} response`);
        }

        const result = textPart.text.trim();
        log.info({ [options.label]: result }, `${options.label} generated`);
        return result;
      } finally {
        await client.session.delete({ sessionID: session.id }).catch(() => {});
      }
    } finally {
      this.systemSandbox.release();
    }
  }

  private buildDescriptionPrompt(
    workspace: Workspace,
    trigger: DescriptionTrigger,
  ): string {
    const action = trigger === "created" ? "created" : "updated";
    const repos = workspace.config.repos;

    const repoList = repos
      .map((repo) => {
        const ref = "url" in repo ? repo.url : repo.repo;
        return `  - ${ref} (branch: ${repo.branch})`;
      })
      .join("\n");

    return [
      `Workspace "${workspace.name}" was just ${action}.`,
      `It contains the following git repos:`,
      repoList,
      ``,
      `Explore these repos and output a concise 2-3 line`,
      `semi-technical description of this workspace.`,
      ``,
      `This description helps an AI agent pick the right`,
      `workspace for a task. Make it unambiguous which`,
      `project this is and what kind of work happens here.`,
      ``,
      `Focus on: project/product name, what it does,`,
      `key technologies, and repo structure if multiple.`,
      ``,
      `Output ONLY the description text, nothing else.`,
    ].join("\n");
  }
}
