import * as fs from "node:fs";
import {
  AUTH_PROVIDERS,
  SHARED_STORAGE,
  VM_PATHS,
} from "@frak-sandbox/shared/constants";
import type { AgentClient } from "../../infrastructure/agent/agent.client.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { ConfigFileService } from "../config-file/config-file.service.ts";
import type { SandboxService } from "../sandbox/sandbox.service.ts";
import type { SharedAuthRepository } from "./internal.repository.ts";

const log = createChildLogger("internal-service");

export interface AuthContent {
  content: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface SharedAuthInfo {
  provider: string;
  path: string;
  description: string;
  content: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

const AUTH_POLL_INTERVAL_MS = 5_000;

export class InternalService {
  private authPollTimer: Timer | null = null;

  constructor(
    private readonly sharedAuthRepository: SharedAuthRepository,
    private readonly configFileService: ConfigFileService,
    private readonly agentClient: AgentClient,
    private readonly sandboxService: SandboxService,
  ) {}

  startAuthWatcher(): void {
    const dir = SHARED_STORAGE.AUTH_DIR;

    if (!fs.existsSync(dir)) {
      log.warn({ dir }, "Auth directory does not exist, skipping watcher");
      return;
    }

    this.authPollTimer = setInterval(() => {
      this.pollAuthFromSandboxes();
    }, AUTH_POLL_INTERVAL_MS);

    log.info(
      { dir, intervalMs: AUTH_POLL_INTERVAL_MS },
      "Auth polling started",
    );
  }

  stopAuthWatcher(): void {
    if (this.authPollTimer) {
      clearInterval(this.authPollTimer);
      this.authPollTimer = null;
    }
  }

  private async pollAuthFromSandboxes(): Promise<void> {
    const runningSandboxes = this.sandboxService
      .getAll()
      .filter((s) => s.status === "running");
    if (runningSandboxes.length === 0) return;

    // Pick first running sandbox to read auth from (all should have same auth)
    // biome-ignore lint/style/noNonNullAssertion: length check above guarantees non-null
    const sandbox = runningSandboxes[0]!;

    for (const provider of AUTH_PROVIDERS) {
      try {
        const result = await this.agentClient.exec(
          sandbox.id,
          `cat ${provider.path} 2>/dev/null`,
          { timeout: 5000 },
        );
        if (result.exitCode !== 0 || !result.stdout.trim()) continue;

        const content = result.stdout.trim();
        const existing = this.sharedAuthRepository.getByProvider(provider.name);
        if (existing?.content === content) continue;

        this.sharedAuthRepository.upsert(provider.name, content, "sandbox");
        log.info({ provider: provider.name }, "Auth synced from sandbox to DB");

        // Push updated auth to all OTHER sandboxes
        await this.pushAuthToSandboxes(provider, content, sandbox.id);
      } catch (error) {
        log.debug(
          { provider: provider.name, error },
          "Failed to poll auth from sandbox",
        );
      }
    }
  }

  private async pushAuthToSandboxes(
    provider: (typeof AUTH_PROVIDERS)[number],
    content: string,
    excludeSandboxId?: string,
  ): Promise<void> {
    const runningSandboxes = this.sandboxService
      .getAll()
      .filter((s) => s.status === "running" && s.id !== excludeSandboxId);

    await Promise.allSettled(
      runningSandboxes.map((sandbox) =>
        this.agentClient.exec(
          sandbox.id,
          `mkdir -p "$(dirname '${provider.path}')" && cat > '${provider.path}' << 'AUTHEOF'\n${content}\nAUTHEOF`,
          { timeout: 5000 },
        ),
      ),
    );
  }

  listAuth(): SharedAuthInfo[] {
    const storedAuth = this.sharedAuthRepository.list();
    const storedByProvider = new Map(storedAuth.map((a) => [a.provider, a]));

    return AUTH_PROVIDERS.map((provider) => {
      const stored = storedByProvider.get(provider.name);
      return {
        provider: provider.name,
        path: provider.path,
        description: provider.description,
        content: stored?.content ?? null,
        updatedAt: stored?.updatedAt ?? null,
        updatedBy: stored?.updatedBy ?? null,
      };
    });
  }

  async getAuth(provider: string): Promise<AuthContent | null> {
    const record = this.sharedAuthRepository.getByProvider(provider);
    if (!record) return null;

    return {
      content: record.content,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
    };
  }

  updateAuth(provider: string, content: string): SharedAuthInfo {
    const providerInfo = AUTH_PROVIDERS.find((p) => p.name === provider);
    if (!providerInfo) {
      throw new Error(`Unknown auth provider: ${provider}`);
    }

    const record = this.sharedAuthRepository.upsert(
      provider,
      content,
      "dashboard",
    );

    log.info({ provider }, "Auth updated from dashboard");

    this.syncAuthToSandboxes().catch((error) => {
      log.error(
        { error },
        "Failed to sync auth to sandboxes after dashboard update",
      );
    });

    return {
      provider: record.provider,
      path: providerInfo.path,
      description: providerInfo.description,
      content: record.content,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
    };
  }

  async syncAuthToSandboxes(): Promise<{ synced: number }> {
    const storedAuth = this.sharedAuthRepository.list();
    let synced = 0;

    // Write to host dir for persistence
    for (const auth of storedAuth) {
      const hostPath = `${SHARED_STORAGE.AUTH_DIR}/${auth.provider}.json`;
      try {
        const tmpPath = `${hostPath}.tmp`;
        await Bun.write(tmpPath, auth.content);
        await Bun.$`chown 1000:1000 ${tmpPath}`.quiet();
        await Bun.$`mv ${tmpPath} ${hostPath}`.quiet();
      } catch (error) {
        log.error(
          { provider: auth.provider, error },
          "Failed to write auth to host dir",
        );
      }
    }

    // Push to all running sandboxes
    const runningSandboxes = this.sandboxService
      .getAll()
      .filter((s) => s.status === "running");
    for (const auth of storedAuth) {
      const provider = AUTH_PROVIDERS.find((p) => p.name === auth.provider);
      if (!provider) continue;

      await Promise.allSettled(
        runningSandboxes.map((sandbox) =>
          this.agentClient.exec(
            sandbox.id,
            `mkdir -p "$(dirname '${provider.path}')" && cat > '${provider.path}' << 'AUTHEOF'\n${auth.content}\nAUTHEOF`,
            { timeout: 5000 },
          ),
        ),
      );
      synced++;
    }

    log.info(
      { synced, sandboxes: runningSandboxes.length },
      "Auth sync complete",
    );
    return { synced };
  }

  async syncConfigsToSandboxes(): Promise<{ synced: number }> {
    const globalConfigs = this.configFileService.list({ scope: "global" });
    let synced = 0;

    // Write global configs to host dir for persistence
    for (const config of globalConfigs) {
      const hostPath = `${SHARED_STORAGE.CONFIGS_DIR}/${SHARED_STORAGE.CONFIG_DIRS.GLOBAL}${config.path}`;
      const dir = hostPath.substring(0, hostPath.lastIndexOf("/"));

      try {
        await Bun.$`mkdir -p ${dir}`.quiet();

        if (config.contentType === "binary") {
          const buffer = Buffer.from(config.content, "base64");
          await Bun.write(hostPath, buffer);
        } else {
          await Bun.write(hostPath, config.content);
        }

        log.debug(
          { path: config.path, hostPath },
          "Config written to host dir",
        );
      } catch (error) {
        log.error(
          { path: config.path, error },
          "Failed to write config to host dir",
        );
      }
    }

    const workspaceConfigs = this.configFileService.list({
      scope: "workspace",
    });
    const byWorkspace = new Map<string, typeof workspaceConfigs>();

    for (const config of workspaceConfigs) {
      if (!config.workspaceId) continue;
      const existing = byWorkspace.get(config.workspaceId) ?? [];
      existing.push(config);
      byWorkspace.set(config.workspaceId, existing);
    }

    // Write workspace configs to host dir for persistence
    for (const [workspaceId, configs] of byWorkspace) {
      for (const config of configs) {
        const hostPath = `${SHARED_STORAGE.CONFIGS_DIR}/${SHARED_STORAGE.CONFIG_DIRS.WORKSPACES}/${workspaceId}${config.path}`;
        const dir = hostPath.substring(0, hostPath.lastIndexOf("/"));

        try {
          await Bun.$`mkdir -p ${dir}`.quiet();

          if (config.contentType === "binary") {
            const buffer = Buffer.from(config.content, "base64");
            await Bun.write(hostPath, buffer);
          } else {
            await Bun.write(hostPath, config.content);
          }

          log.debug(
            { path: config.path, hostPath, workspaceId },
            "Workspace config written to host dir",
          );
        } catch (error) {
          log.error(
            { path: config.path, workspaceId, error },
            "Failed to write workspace config to host dir",
          );
        }
      }
    }

    // Push all configs to running sandboxes
    const runningSandboxes = this.sandboxService
      .getAll()
      .filter((s) => s.status === "running");
    const allConfigs = [...globalConfigs, ...workspaceConfigs];

    for (const config of allConfigs) {
      const vmPath = this.getVmPathForConfig(config.path);
      if (!vmPath) {
        log.debug({ path: config.path }, "No VM path mapping found for config");
        continue;
      }

      await Promise.allSettled(
        runningSandboxes.map((sandbox) =>
          this.agentClient.exec(
            sandbox.id,
            `mkdir -p "$(dirname '${vmPath}')" && cat > '${vmPath}' << 'CONFIGEOF'\n${config.content}\nCONFIGEOF`,
            { timeout: 5000 },
          ),
        ),
      );
      synced++;
    }

    log.info(
      { synced, sandboxes: runningSandboxes.length },
      "Config sync complete",
    );
    return { synced };
  }

  private getVmPathForConfig(configPath: string): string | null {
    // Map config paths to VM paths based on the config type
    if (configPath.includes("opencode")) {
      if (configPath.includes("opencode.json")) return VM_PATHS.opencodeConfig;
      if (configPath.includes("oh-my-opencode")) return VM_PATHS.opencodeOhMy;
      if (configPath.includes("antigravity"))
        return VM_PATHS.antigravityAccounts;
    }
    if (configPath.includes("vscode") || configPath.includes("code-server")) {
      return VM_PATHS.vscodeSettings;
    }
    return null;
  }
}
