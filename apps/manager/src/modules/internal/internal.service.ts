import { AUTH_PROVIDERS, VM } from "@frak/atelier-shared/constants";
import type { AgentClient } from "../../infrastructure/agent/agent.client.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { ConfigFileService } from "../config-file/config-file.service.ts";
import type { SandboxRepository } from "../sandbox/index.ts";
import type { SandboxProvisionService } from "../sandbox/sandbox-provision.service.ts";
import type { AuthSyncService } from "./auth-sync.service.ts";

const log = createChildLogger("internal-service");

export class InternalService {
  constructor(
    private readonly authSyncService: AuthSyncService,
    private readonly configFileService: ConfigFileService,
    private readonly agentClient: AgentClient,
    private readonly sandboxService: SandboxRepository,
    private readonly provisionService: SandboxProvisionService,
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
        await this.provisionService.pushFilesToSandbox(
          sandboxId,
          files,
          "config",
        );
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

    await this.provisionService.pushFilesToSandbox(sandboxId, files, "config");
    log.info({ synced: files.length, sandboxId }, "Configs pushed to sandbox");
    return { synced: files.length };
  }

  private getConfigFilesToPush(workspaceId?: string): {
    files: { path: string; content: string }[];
  } {
    const authManagedPaths = new Set<string>(AUTH_PROVIDERS.map((p) => p.path));
    const merged = this.configFileService.getMergedForSandbox(workspaceId);
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

  async syncRegistryToSandboxes(enabled: boolean): Promise<{ synced: number }> {
    const runningSandboxes = this.sandboxService
      .getAll()
      .filter((s) => s.status === "running");
    if (runningSandboxes.length === 0) return { synced: 0 };

    const sandboxIds = runningSandboxes.map((s) => s.id);

    if (enabled) {
      for (const sandboxId of sandboxIds) {
        await this.provisionService.pushRegistryConfig(sandboxId);
      }
    } else {
      const commands = [
        {
          id: "registry-remove",
          command: `rm -f /etc/profile.d/registry.sh /etc/npmrc ${VM.HOME}/.bunfig.toml ${VM.HOME}/.yarnrc.yml`,
          timeout: 5000,
        },
      ];

      const results = await Promise.allSettled(
        sandboxIds.map((sandboxId) =>
          this.agentClient.batchExec(sandboxId, commands, { timeout: 10000 }),
        ),
      );

      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        log.warn(
          { failures: failures.length, total: results.length },
          "Some registry config removals failed",
        );
      }
    }

    log.info(
      { enabled, sandboxes: sandboxIds.length },
      "Registry sync to sandboxes complete",
    );
    return { synced: sandboxIds.length };
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
      this.provisionService
        .pushRegistryConfig(sandboxId)
        .then(() => true)
        .catch(() => false),
    ]);

    return {
      auth: authConfigs.auth,
      configs: authConfigs.configs,
      registry,
    };
  }
}
