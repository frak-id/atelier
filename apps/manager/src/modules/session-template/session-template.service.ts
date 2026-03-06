import { DEFAULT_SESSION_TEMPLATES } from "@frak/atelier-shared/constants";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type {
  SessionTemplate,
  SessionTemplates,
  SessionTemplateVariables,
} from "../../schemas/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { buildOpenCodeAuthHeaders } from "../../shared/lib/opencode-auth.ts";
import type { SandboxRepository } from "../sandbox/index.ts";
import type { SettingsRepository } from "../settings/index.ts";
import type { WorkspaceService } from "../workspace/index.ts";

const log = createChildLogger("session-template-service");

const SETTINGS_KEY = "session-templates";

interface ResolvedSessionConfig {
  model: { providerID: string; modelID: string };
  variant?: string;
  agent?: string;
  promptTemplate?: string;
}

export class SessionTemplateService {
  constructor(
    private readonly settingsRepository: SettingsRepository,
    private readonly workspaceService: WorkspaceService,
    private readonly sandboxService: SandboxRepository,
  ) {}

  getGlobalTemplates(): { templates: SessionTemplates; isDefault: boolean } {
    const templates =
      this.settingsRepository.get<SessionTemplates>(SETTINGS_KEY);

    if (!templates || templates.length === 0) {
      return { templates: DEFAULT_SESSION_TEMPLATES, isDefault: true };
    }

    return { templates, isDefault: false };
  }

  setGlobalTemplates(templates: SessionTemplates): void {
    this.settingsRepository.set(SETTINGS_KEY, templates);
  }

  getWorkspaceTemplates(workspaceId: string): SessionTemplates | undefined {
    const workspace = this.workspaceService.getById(workspaceId);
    return workspace?.config.sessionTemplates;
  }

  getMergedTemplates(workspaceId?: string): {
    templates: SessionTemplates;
    source: "default" | "global" | "workspace" | "merged";
  } {
    const { templates: globalTemplates, isDefault } = this.getGlobalTemplates();

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
  ): SessionTemplate | undefined {
    const { templates } = this.getMergedTemplates(workspaceId);
    return templates.find((t) => t.id === templateId);
  }

  getDefaultTemplate(workspaceId?: string): SessionTemplate {
    const { templates } = this.getMergedTemplates(workspaceId);
    const final = templates[0] ?? DEFAULT_SESSION_TEMPLATES[0];
    if (!final) {
      throw new Error("No default session template available");
    }
    return final;
  }

  getTemplatesByCategory(
    category: "primary" | "secondary",
    workspaceId?: string,
  ): SessionTemplate[] {
    const { templates } = this.getMergedTemplates(workspaceId);
    return templates.filter((t) => t.category === category);
  }

  resolveSessionConfig(
    templateId: string,
    workspaceId?: string,
  ): ResolvedSessionConfig | undefined {
    const template = this.getTemplateById(templateId, workspaceId);
    if (!template) {
      const defaultTemplate = DEFAULT_SESSION_TEMPLATES[0];
      if (!defaultTemplate?.variants?.[0]) return undefined;
      return {
        model: defaultTemplate.variants[0].model,
        variant: defaultTemplate.variants[0].variant,
        agent: defaultTemplate.variants[0].agent,
        promptTemplate: defaultTemplate.promptTemplate,
      };
    }

    const variantIndex = template.defaultVariantIndex ?? 0;
    const variant = template.variants[variantIndex];
    if (!variant) return undefined;

    return {
      model: variant.model,
      variant: variant.variant,
      agent: variant.agent,
      promptTemplate: template.promptTemplate,
    };
  }

  renderPromptTemplate(
    template: SessionTemplate,
    variables: SessionTemplateVariables,
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

  private buildDefaultPrompt(variables: SessionTemplateVariables): string {
    let prompt = "";

    if (variables.task.branch) {
      prompt += `**Working branch:** \`${variables.task.branch}\`\n\n`;
    }

    prompt += variables.task.description;

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
    base: SessionTemplates,
    override: SessionTemplates,
  ): SessionTemplates {
    const result = new Map<string, SessionTemplate>();

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

  async getOpenCodeConfig(workspaceId: string) {
    const sandboxes = this.sandboxService.getByWorkspaceId(workspaceId);
    const runningSandbox = sandboxes.find((s) => s.status === "running");

    if (!runningSandbox) {
      return { available: false };
    }

    return this.fetchOpenCodeConfigFromSandbox(runningSandbox);
  }

  async getOpenCodeConfigFromAnySandbox() {
    const allSandboxes = this.sandboxService.getAll();
    const runningSandbox = allSandboxes.find((s) => s.status === "running");

    if (!runningSandbox) {
      return { available: false };
    }

    return this.fetchOpenCodeConfigFromSandbox(runningSandbox);
  }

  private async fetchOpenCodeConfigFromSandbox(sandbox: {
    id: string;
    runtime?: { ipAddress?: string; opencodePassword?: string };
  }) {
    const ipAddress = sandbox.runtime?.ipAddress;
    if (!ipAddress) {
      return { available: false };
    }

    try {
      const client = createOpencodeClient({
        baseUrl: `http://${ipAddress}:${config.ports.opencode}`,
        headers: buildOpenCodeAuthHeaders(sandbox.runtime?.opencodePassword),
      });

      const [providersResult, agentsResult] = await Promise.all([
        client.provider.list(),
        client.app.agents(),
      ]);

      const connectedProviders = providersResult.data?.connected ?? [];
      const providers =
        providersResult.data?.all?.filter((p) =>
          connectedProviders.includes(p.id),
        ) ?? [];
      const agents = agentsResult.data ?? [];

      return {
        available: true,
        sandboxId: sandbox.id,
        providers: providers,
        agents: agents,
      };
    } catch (error) {
      log.warn(
        { sandboxId: sandbox.id, error: String(error) },
        "Failed to fetch OpenCode config",
      );
      return { available: false, sandboxId: sandbox.id };
    }
  }
}
