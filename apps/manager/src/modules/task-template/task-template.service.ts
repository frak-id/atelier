import {
  DEFAULT_TASK_TEMPLATES,
  TASK_TEMPLATES_CONFIG_PATH,
} from "@frak-sandbox/shared/constants";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type {
  TaskTemplate,
  TaskTemplates,
  TaskTemplateVariables,
} from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { ConfigFileService } from "../config-file/index.ts";
import type { SandboxService } from "../sandbox/index.ts";
import type { WorkspaceService } from "../workspace/index.ts";

const log = createChildLogger("task-template-service");

export class TaskTemplateService {
  constructor(
    private readonly configFileService: ConfigFileService,
    private readonly workspaceService: WorkspaceService,
    private readonly sandboxService: SandboxService,
  ) {}

  getGlobalTemplates(): TaskTemplates {
    const configFile = this.configFileService.getByPath(
      TASK_TEMPLATES_CONFIG_PATH,
      "global",
    );

    if (!configFile) {
      return DEFAULT_TASK_TEMPLATES;
    }

    try {
      const templates = JSON.parse(configFile.content) as TaskTemplates;
      return templates.length > 0 ? templates : DEFAULT_TASK_TEMPLATES;
    } catch (error) {
      log.warn(
        { error },
        "Failed to parse global task templates, using defaults",
      );
      return DEFAULT_TASK_TEMPLATES;
    }
  }

  setGlobalTemplates(templates: TaskTemplates): void {
    const content = JSON.stringify(templates, null, 2);
    this.configFileService.extractFromSandbox(
      undefined,
      TASK_TEMPLATES_CONFIG_PATH,
      content,
      "json",
    );
  }

  getWorkspaceTemplates(workspaceId: string): TaskTemplates | undefined {
    const workspace = this.workspaceService.getById(workspaceId);
    return workspace?.config.taskTemplates;
  }

  getMergedTemplates(workspaceId?: string): {
    templates: TaskTemplates;
    source: "default" | "global" | "workspace" | "merged";
  } {
    const globalTemplates = this.getGlobalTemplates();
    const isDefault = globalTemplates === DEFAULT_TASK_TEMPLATES;

    if (!workspaceId) {
      return {
        templates: globalTemplates,
        source: isDefault ? "default" : "global",
      };
    }

    const workspaceTemplates = this.getWorkspaceTemplates(workspaceId);
    if (!workspaceTemplates || workspaceTemplates.length === 0) {
      return {
        templates: globalTemplates,
        source: isDefault ? "default" : "global",
      };
    }

    const merged = this.deepMergeTemplates(globalTemplates, workspaceTemplates);
    return { templates: merged, source: "merged" };
  }

  getTemplateById(
    templateId: string,
    workspaceId?: string,
  ): TaskTemplate | undefined {
    const { templates } = this.getMergedTemplates(workspaceId);
    return templates.find((t) => t.id === templateId);
  }

  getDefaultTemplate(workspaceId?: string): TaskTemplate {
    const { templates } = this.getMergedTemplates(workspaceId);
    return templates[0] ?? DEFAULT_TASK_TEMPLATES[0]!;
  }

  renderPromptTemplate(
    template: TaskTemplate,
    variables: TaskTemplateVariables,
  ): string {
    if (!template.promptTemplate) {
      return this.buildDefaultPrompt(variables);
    }

    return template.promptTemplate.replace(/\$\{([^}]+)\}/g, (match, path) => {
      const value = this.getNestedValue(variables, path.trim());
      if (value === undefined) {
        log.warn({ path }, "Template variable not found");
        return match;
      }
      if (Array.isArray(value)) {
        return value.join(", ");
      }
      return String(value);
    });
  }

  private buildDefaultPrompt(variables: TaskTemplateVariables): string {
    let prompt = `# Task: ${variables.task.title}\n\n`;

    if (variables.task.branch) {
      prompt += `**Working branch:** \`${variables.task.branch}\`\n\n`;
    }

    prompt += variables.task.description;

    if (variables.task.context) {
      prompt += `\n\n## Additional Context\n${variables.task.context}`;
    }

    return prompt;
  }

  private getNestedValue(obj: unknown, path: string): unknown {
    const parts = path.split(".");
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      if (typeof current === "object") {
        current = (current as Record<string, unknown>)[part];
      } else {
        return undefined;
      }
    }

    return current;
  }

  private deepMergeTemplates(
    base: TaskTemplates,
    override: TaskTemplates,
  ): TaskTemplates {
    const result = new Map<string, TaskTemplate>();

    for (const template of base) {
      result.set(template.id, { ...template });
    }

    for (const template of override) {
      const existing = result.get(template.id);
      if (existing) {
        result.set(template.id, {
          ...existing,
          ...template,
          variants:
            template.variants.length > 0
              ? template.variants
              : existing.variants,
        });
      } else {
        result.set(template.id, template);
      }
    }

    return Array.from(result.values());
  }

  async getOpenCodeConfig(workspaceId: string): Promise<{
    available: boolean;
    sandboxId?: string;
    providers?: Array<{
      id: string;
      name: string;
      models: Record<
        string,
        { id: string; name: string; variants?: Record<string, unknown> }
      >;
    }>;
    agents?: Array<{ name: string; description?: string; mode: string }>;
  }> {
    const sandboxes = this.sandboxService.getByWorkspaceId(workspaceId);
    const runningSandbox = sandboxes.find((s) => s.status === "running");

    if (!runningSandbox) {
      return { available: false };
    }

    const ipAddress = runningSandbox.runtime?.ipAddress;
    if (!ipAddress) {
      return { available: false };
    }

    try {
      const client = createOpencodeClient({
        baseUrl: `http://${ipAddress}:3000`,
      });

      const [providersResult, agentsResult] = await Promise.all([
        client.provider.list(),
        client.app.agents(),
      ]);

      const providers = providersResult.data?.all ?? [];
      const agents = agentsResult.data ?? [];

      return {
        available: true,
        sandboxId: runningSandbox.id,
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name,
          models: Object.fromEntries(
            Object.entries(p.models).map(([key, model]) => [
              key,
              {
                id: model.id,
                name: model.name,
                variants: model.variants,
              },
            ]),
          ),
        })),
        agents: agents.map((a) => ({
          name: a.name,
          description: a.description,
          mode: a.mode,
        })),
      };
    } catch (error) {
      log.warn(
        { workspaceId, sandboxId: runningSandbox.id, error: String(error) },
        "Failed to fetch OpenCode config",
      );
      return { available: false, sandboxId: runningSandbox.id };
    }
  }
}
