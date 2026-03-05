import { AUTH_PROVIDERS, VM } from "@frak/atelier-shared/constants";
import type { AgentClient } from "../../infrastructure/agent/agent.client.ts";
import { RegistryService } from "../../infrastructure/registry/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { ConfigFileService } from "../config-file/config-file.service.ts";
import type { SandboxRepository } from "../sandbox/index.ts";
import {
  SYSTEM_AGENTS_CONFIG,
  SYSTEM_WORKSPACE_ID,
} from "../system-sandbox/index.ts";
import type { AuthSyncService } from "./auth-sync.service.ts";

const CLIPROXY_PROVIDER_PATH = "/.atelier/cliproxy-opencode-provider.json";
const CLIPROXY_SETTINGS_PATH = "/.atelier/cliproxy-settings.json";

const log = createChildLogger("internal-service");

export class InternalService {
  constructor(
    private readonly authSyncService: AuthSyncService,
    private readonly configFileService: ConfigFileService,
    private readonly agentClient: AgentClient,
    private readonly sandboxService: SandboxRepository,
  ) {}

  async syncConfigsToSandboxes(): Promise<{ synced: number }> {
    const runningSandboxes = this.sandboxService
      .getAll()
      .filter((s) => s.status === "running");
    if (runningSandboxes.length === 0) return { synced: 0 };

    const byWorkspace = new Map<string | undefined, string[]>();
    for (const sandbox of runningSandboxes) {
      const key = sandbox.workspaceId ?? undefined;
      const ids = byWorkspace.get(key) ?? [];
      ids.push(sandbox.id);
      byWorkspace.set(key, ids);
    }

    let totalSynced = 0;
    for (const [workspaceId, sandboxIds] of byWorkspace) {
      const { files } = this.getConfigFilesToPush(workspaceId);
      if (files.length === 0) continue;

      for (const sandboxId of sandboxIds) {
        await this.pushFilesToSandbox(sandboxId, files, "config");
      }
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

  async syncConfigsToSandbox(sandboxId: string): Promise<{ synced: number }> {
    const sandbox = this.sandboxService.getById(sandboxId);
    const workspaceId = sandbox?.workspaceId ?? undefined;
    const { files } = this.getConfigFilesToPush(workspaceId);
    if (files.length === 0) return { synced: 0 };

    await this.pushFilesToSandbox(sandboxId, files, "config");
    log.info({ synced: files.length, sandboxId }, "Configs pushed to sandbox");
    return { synced: files.length };
  }

  private getConfigFilesToPush(workspaceId?: string): {
    files: { path: string; content: string }[];
  } {
    const authManagedPaths = new Set<string>(AUTH_PROVIDERS.map((p) => p.path));
    const merged = this.configFileService.getMergedForSandbox(workspaceId);

    if (workspaceId === SYSTEM_WORKSPACE_ID) {
      this.injectSystemAgents(merged);
    }

    this.injectCliProxyProvider(merged);

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

  private injectCliProxyProvider(
    merged: { path: string; content: string; contentType: string }[],
  ): void {
    const settingsFile = this.configFileService.getByPath(
      CLIPROXY_SETTINGS_PATH,
      "global",
    );
    if (!settingsFile) return;

    let enabled = false;
    try {
      enabled =
        (JSON.parse(settingsFile.content) as { enabled?: boolean }).enabled ===
        true;
    } catch {
      return;
    }
    if (!enabled) return;

    const providerFile = this.configFileService.getByPath(
      CLIPROXY_PROVIDER_PATH,
      "global",
    );
    if (!providerFile) return;

    let providerConfig: Record<string, unknown>;
    try {
      providerConfig = JSON.parse(providerFile.content) as Record<
        string,
        unknown
      >;
    } catch {
      log.warn("Failed to parse CLIProxy provider config");
      return;
    }

    const configPath = "~/.config/opencode/opencode.json";
    const existing = merged.find((c) => c.path === configPath);

    if (existing && existing.contentType === "json") {
      try {
        const parsed = JSON.parse(existing.content) as Record<string, unknown>;
        const existingProvider =
          (parsed.provider as Record<string, unknown>) ?? {};
        parsed.provider = { ...existingProvider, cliproxy: providerConfig };
        existing.content = JSON.stringify(parsed);
      } catch {
        log.warn("Failed to merge CLIProxy provider into opencode config");
      }
    } else if (!existing) {
      merged.push({
        path: configPath,
        content: JSON.stringify({ provider: { cliproxy: providerConfig } }),
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
    const isHealthy = await RegistryService.checkHealth();
    if (!isHealthy) return;

    const registryUrl = RegistryService.getRegistryUrl();
    const registryHost = new URL(registryUrl).hostname;

    const files = [
      {
        path: "/etc/profile.d/registry.sh",
        content: `export NPM_CONFIG_REGISTRY="${registryUrl}"`,
      },
      {
        path: "/etc/npmrc",
        content: `registry=${registryUrl}`,
      },
      {
        path: `${VM.HOME}/.bunfig.toml`,
        content: `[install]\nregistry = "${registryUrl}"`,
      },
      {
        path: `${VM.HOME}/.yarnrc.yml`,
        content: `npmRegistryServer: "${registryUrl}"\nunsafeHttpWhitelist:\n  - "${registryHost}"`,
      },
    ];

    await this.pushFilesToSandbox(sandboxId, files, "registry");
    log.debug({ sandboxId }, "Registry config pushed");
  }
}
