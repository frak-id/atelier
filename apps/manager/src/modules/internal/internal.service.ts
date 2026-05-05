import { AUTH_PROVIDERS, VM } from "@frak/atelier-shared/constants";
import type { AgentClient } from "../../infrastructure/agent/agent.client.ts";
import { RegistryService } from "../../infrastructure/registry/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { CLIProxyService } from "../cliproxy/cliproxy.service.ts";
import type { ConfigFileService } from "../config-file/config-file.service.ts";
import type { SandboxRepository } from "../sandbox/index.ts";
import type { SettingsRepository } from "../settings/index.ts";
import { SYSTEM_AGENTS_CONFIG } from "../system-sandbox/index.ts";
import type { AuthSyncService } from "./auth-sync.service.ts";

const CLIPROXY_SETTINGS_KEY = "cliproxy.settings";
const CLIPROXY_PROVIDERS_KEY = "cliproxy.providers";

const log = createChildLogger("internal-service");

export class InternalService {
  private cliProxyService: CLIProxyService | null = null;

  constructor(
    private readonly authSyncService: AuthSyncService,
    private readonly configFileService: ConfigFileService,
    private readonly settingsRepository: SettingsRepository,
    private readonly agentClient: AgentClient,
    private readonly sandboxService: SandboxRepository,
  ) {}

  setCliProxyService(service: CLIProxyService): void {
    this.cliProxyService = service;
  }

  async syncConfigsToSandboxes(): Promise<{ synced: number }> {
    const runningSandboxes = this.sandboxService
      .getAll()
      .filter((s) => s.status === "running");
    if (runningSandboxes.length === 0) return { synced: 0 };

    let totalSynced = 0;
    for (const sandbox of runningSandboxes) {
      const { files } = this.getConfigFilesToPush({
        workspaceId: sandbox.workspaceId,
        sandboxId: sandbox.id,
        system: sandbox.origin?.source === "system",
      });
      if (files.length === 0) continue;
      await this.pushFilesToSandbox(sandbox.id, files, "config");
      totalSynced += files.length;
    }

    log.info(
      { synced: totalSynced, sandboxes: runningSandboxes.length },
      "Config sync complete",
    );
    return { synced: totalSynced };
  }

  async syncToSandbox(
    sandboxId: string,
  ): Promise<{ auth: { synced: number }; configs: { synced: number } }> {
    const [authResult, configResult] = await Promise.allSettled([
      this.authSyncService.syncAuthToSandbox(sandboxId),
      this.syncConfigsToSandbox(sandboxId),
    ]);

    const auth =
      authResult.status === "fulfilled" ? authResult.value : { synced: 0 };
    const configs =
      configResult.status === "fulfilled" ? configResult.value : { synced: 0 };

    if (authResult.status === "rejected") {
      log.warn(
        { sandboxId, error: authResult.reason },
        "Failed to push auth to sandbox",
      );
    }
    if (configResult.status === "rejected") {
      log.warn(
        { sandboxId, error: configResult.reason },
        "Failed to push configs to sandbox",
      );
    }

    return { auth, configs };
  }

  /**
   * Push merged config files (opencode config, MCP server, plugin manifests,
   * etc.) to a sandbox.
   *
   * Pass `override` when the target sandbox isn't yet a real DB record —
   * e.g. during prebuild, where we still want the workspace's configs (or
   * system configs) to land in the snapshot but the prebuild pod has no
   * `Sandbox` row to derive context from.
   */
  async syncConfigsToSandbox(
    sandboxId: string,
    override?: { workspaceId?: string; system?: boolean },
  ): Promise<{ synced: number }> {
    const sandbox = override
      ? undefined
      : this.sandboxService.getById(sandboxId);
    const workspaceId = override?.workspaceId ?? sandbox?.workspaceId;
    const system = override?.system ?? sandbox?.origin?.source === "system";
    const { files } = this.getConfigFilesToPush({
      workspaceId,
      sandboxId,
      system,
    });
    if (files.length === 0) return { synced: 0 };

    await this.pushFilesToSandbox(sandboxId, files, "config");
    log.info({ synced: files.length, sandboxId }, "Configs pushed to sandbox");
    return { synced: files.length };
  }

  private getConfigFilesToPush(opts: {
    workspaceId?: string;
    sandboxId?: string;
    system?: boolean;
  }): {
    files: { path: string; content: string }[];
  } {
    const authManagedPaths = new Set<string>(AUTH_PROVIDERS.map((p) => p.path));
    const merged = this.configFileService.getMergedForSandbox(opts.workspaceId);

    if (opts.system) {
      this.injectSystemAgents(merged);
      this.injectMcpServer(merged);
    }

    this.injectCliProxyProvider(merged, opts.sandboxId);

    const files: { path: string; content: string }[] = [];

    for (const cfg of merged) {
      const vmPath = this.getVmPathForConfig(cfg.path);
      if (!vmPath) {
        log.debug({ path: cfg.path }, "No VM path mapping found for config");
        continue;
      }
      if (authManagedPaths.has(vmPath)) {
        log.debug(
          { path: vmPath },
          "Skipping config file managed by shared_auth",
        );
        continue;
      }
      files.push({ path: vmPath, content: cfg.content });
    }

    return { files };
  }

  private injectSystemAgents(
    merged: {
      path: string;
      content: string;
      contentType: string;
    }[],
  ): void {
    const configPath = "~/.config/opencode/opencode.json";
    const existing = merged.find((c) => c.path === configPath);

    if (existing && existing.contentType === "json") {
      try {
        const parsed = JSON.parse(existing.content);
        parsed.agent = {
          ...parsed.agent,
          ...SYSTEM_AGENTS_CONFIG.agent,
        };
        existing.content = JSON.stringify(parsed);
      } catch {
        log.warn("Failed to parse existing opencode config for system agents");
      }
    } else if (!existing) {
      merged.push({
        path: configPath,
        content: JSON.stringify(SYSTEM_AGENTS_CONFIG),
        contentType: "json",
      });
    }
  }

  private injectMcpServer(
    merged: {
      path: string;
      content: string;
      contentType: string;
    }[],
  ): void {
    const managerUrl = config.kubernetes.managerUrl;
    if (!managerUrl) return;

    const mcpToken = config.server.mcpToken;
    const mcpConfig: Record<string, unknown> = {
      "atelier-manager": {
        type: "remote",
        url: `${managerUrl}/mcp`,
        enabled: true,
        ...(mcpToken && {
          headers: { Authorization: `Bearer ${mcpToken}` },
        }),
        oauth: false,
        timeout: 10000,
      },
    };

    const configPath = "~/.config/opencode/opencode.json";
    const existing = merged.find((c) => c.path === configPath);

    if (existing && existing.contentType === "json") {
      try {
        const parsed = JSON.parse(existing.content) as Record<string, unknown>;
        const existingMcp = (parsed.mcp as Record<string, unknown>) ?? {};
        parsed.mcp = { ...existingMcp, ...mcpConfig };
        existing.content = JSON.stringify(parsed);
      } catch {
        log.warn("Failed to merge MCP server into opencode config");
      }
    } else if (!existing) {
      merged.push({
        path: configPath,
        content: JSON.stringify({ mcp: mcpConfig }),
        contentType: "json",
      });
    }
  }

  private injectCliProxyProvider(
    merged: { path: string; content: string; contentType: string }[],
    sandboxId?: string,
  ): void {
    const settings = this.settingsRepository.get<{ enabled?: boolean }>(
      CLIPROXY_SETTINGS_KEY,
    );
    if (!settings?.enabled) return;

    const providerConfigs = this.settingsRepository.get<
      Record<string, unknown>
    >(CLIPROXY_PROVIDERS_KEY);
    if (!providerConfigs) return;

    // Deep clone to avoid mutating stored settings
    const configs = JSON.parse(JSON.stringify(providerConfigs)) as Record<
      string,
      unknown
    >;

    if (sandboxId && this.cliProxyService) {
      const sandboxKey = this.cliProxyService.getSandboxApiKey(sandboxId);
      if (sandboxKey) {
        for (const provider of Object.values(configs)) {
          const p = provider as Record<string, unknown>;
          const opts = (p.options as Record<string, unknown>) ?? {};
          p.options = { ...opts, apiKey: sandboxKey };
        }
      }
    }

    const configPath = "~/.config/opencode/opencode.json";
    const existing = merged.find((c) => c.path === configPath);

    if (existing && existing.contentType === "json") {
      try {
        const parsed = JSON.parse(existing.content) as Record<string, unknown>;
        const existingProvider =
          (parsed.provider as Record<string, unknown>) ?? {};
        parsed.provider = { ...existingProvider, ...configs };
        existing.content = JSON.stringify(parsed);
      } catch {
        log.warn("Failed to merge CLIProxy provider into opencode config");
      }
    } else if (!existing) {
      merged.push({
        path: configPath,
        content: JSON.stringify({ provider: configs }),
        contentType: "json",
      });
    }
  }

  private getVmPathForConfig(configPath: string): string | null {
    if (configPath.startsWith("~/")) {
      return `${VM.HOME}/${configPath.slice(2)}`;
    }
    if (configPath.startsWith("/")) {
      return configPath;
    }
    return null;
  }

  async syncAllToSandbox(sandboxId: string): Promise<{
    auth: { synced: number };
    configs: { synced: number };
    registry: boolean;
  }> {
    const [authConfigs, registry] = await Promise.all([
      this.syncToSandbox(sandboxId),
      this.pushRegistryConfig(sandboxId)
        .then(() => true)
        .catch(() => false),
    ]);

    return {
      auth: authConfigs.auth,
      configs: authConfigs.configs,
      registry,
    };
  }

  private async pushFilesToSandbox(
    sandboxId: string,
    files: {
      path: string;
      content: string;
      owner?: "dev" | "root";
    }[],
    label: string,
  ): Promise<void> {
    const fileWrites = files.map((f) => ({
      path: f.path,
      content: f.content,
      owner: f.owner ?? ("dev" as const),
    }));

    try {
      await this.agentClient.writeFiles(sandboxId, fileWrites);
      log.debug({ label, sandboxId, files: files.length }, "Files pushed");
    } catch (error) {
      log.warn({ label, sandboxId, error }, "Failed to push files to sandbox");
      throw error;
    }
  }

  private async pushRegistryConfig(sandboxId: string): Promise<void> {
    const files = await RegistryService.buildRegistryConfigFiles();
    if (!files) return;

    await this.pushFilesToSandbox(sandboxId, files, "registry");
    log.debug({ sandboxId }, "Registry config pushed");
  }
}
