import type { Workspace } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { SystemSandboxService } from "./system-sandbox.service.ts";

const log = createChildLogger("system-ai");

const MAX_FALLBACK_TITLE_LENGTH = 80;

type DescriptionTrigger = "created" | "updated";

interface PromptOptions {
  agent?: string;
  text: string;
  label: string;
}

export class SystemAiService {
  constructor(private readonly systemSandbox: SystemSandboxService) {}

  fallbackTitle(description: string): string {
    const trimmed = description.trim();
    if (trimmed.length <= MAX_FALLBACK_TITLE_LENGTH) return trimmed;

    const truncated = trimmed.slice(0, MAX_FALLBACK_TITLE_LENGTH);
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
      },
      onTitle,
    );
  }

  generateDescriptionInBackground(
    workspace: Workspace,
    trigger: DescriptionTrigger,
    onDescription: (description: string) => void,
  ): void {
    this.runInBackground(
      {
        text: this.buildDescriptionPrompt(workspace, trigger),
        label: "description",
      },
      onDescription,
    );
  }

  private runInBackground(
    options: PromptOptions,
    onResult: (text: string) => void,
  ): void {
    setImmediate(() => {
      this.promptOpenCode(options)
        .then(onResult)
        .catch((error) => {
          log.warn(
            { error, label: options.label },
            `Background ${options.label} generation failed`,
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
      `This workspace was just ${action}.`,
      `It contains the following git repos:`,
      repoList,
      ``,
      `Please explore the git repos thoroughly — clone them`,
      `to a temporary directory if needed — and output a`,
      `concise 2-3 line semi-technical description of this`,
      `workspace.`,
      ``,
      `The description should help AI agents understand what`,
      `this workspace is for and when to use it. Focus on:`,
      `the project's purpose, key technologies/frameworks,`,
      `and the type of work suited for this environment.`,
      ``,
      `Output ONLY the description text, nothing else.`,
    ].join("\n");
  }
}
