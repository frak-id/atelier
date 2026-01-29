import { AUTH_PROVIDERS, VM_PATHS } from "@frak-sandbox/shared/constants";
import type { AgentClient } from "../../infrastructure/agent/agent.client.ts";
import { RegistryService } from "../../infrastructure/registry/index.ts";
import { config } from "../../shared/lib/config.ts";
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

/** OpenCode auth.json entry — mirrors the discriminated union from OpenCode's Auth.Info schema */
interface OAuthEntry {
  type: "oauth";
  refresh: string;
  access: string;
  expires: number;
  accountId?: string;
  enterpriseUrl?: string;
}

interface ApiEntry {
  type: "api";
  key: string;
}

interface WellKnownEntry {
  type: "wellknown";
  key: string;
  token: string;
}

type AuthEntry = OAuthEntry | ApiEntry | WellKnownEntry;

/** OpenCode auth.json structure: provider ID (e.g. "anthropic") → auth entry */
type AuthJson = Record<string, AuthEntry>;

interface AuthFileRead {
  provider: string;
  content: string;
  mtime: number;
}

interface SandboxAuthSnapshot {
  sandboxId: string;
  files: AuthFileRead[];
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
    this.authPollTimer = setInterval(() => {
      this.pollAuthFromSandboxes();
    }, AUTH_POLL_INTERVAL_MS);

    log.info({ intervalMs: AUTH_POLL_INTERVAL_MS }, "Auth polling started");
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

    const snapshots = await this.readAllAuthFromSandboxes(
      runningSandboxes.map((s) => s.id),
    );
    if (snapshots.length === 0) return;

    for (const providerConfig of AUTH_PROVIDERS) {
      try {
        const perProvider = snapshots.flatMap((snap) => {
          const file = snap.files.find(
            (f) => f.provider === providerConfig.name,
          );
          return file ? [{ sandboxId: snap.sandboxId, ...file }] : [];
        });
        if (perProvider.length === 0) continue;

        if (providerConfig.name === "opencode") {
          await this.aggregateOpencodeAuth(perProvider, runningSandboxes);
        } else {
          await this.aggregateOpaqueAuth(
            providerConfig,
            perProvider,
            runningSandboxes,
          );
        }
      } catch (error) {
        log.debug(
          { provider: providerConfig.name, error },
          "Failed to poll auth for provider",
        );
      }
    }
  }

  /**
   * Single batchExec per sandbox: reads mtime + content for every AUTH_PROVIDERS
   * file in one round-trip. Output format per command: first line = epoch mtime,
   * remaining lines = file content.
   */
  private async readAllAuthFromSandboxes(
    sandboxIds: string[],
  ): Promise<SandboxAuthSnapshot[]> {
    const commands = AUTH_PROVIDERS.map((p) => ({
      id: p.name,
      command: `stat -c %Y '${p.path}' 2>/dev/null && cat '${p.path}' 2>/dev/null`,
      timeout: 5000,
    }));

    const results = await Promise.allSettled(
      sandboxIds.map(async (sandboxId) => {
        const batch = await this.agentClient.batchExec(sandboxId, commands, {
          timeout: 10000,
        });

        const files: AuthFileRead[] = [];
        for (const result of batch.results) {
          if (result.exitCode !== 0 || !result.stdout.trim()) continue;

          const firstNewline = result.stdout.indexOf("\n");
          if (firstNewline === -1) continue;

          const mtime = Number.parseInt(
            result.stdout.slice(0, firstNewline),
            10,
          );
          const content = result.stdout.slice(firstNewline + 1).trim();
          if (!content || Number.isNaN(mtime)) continue;

          files.push({ provider: result.id, content, mtime });
        }

        return { sandboxId, files };
      }),
    );

    const snapshots: SandboxAuthSnapshot[] = [];
    for (const result of results) {
      if (result.status === "fulfilled" && result.value.files.length > 0) {
        snapshots.push(result.value);
      }
    }
    return snapshots;
  }

  /**
   * For each key in auth.json (anthropic, openai, etc.), pick the entry
   * with the furthest OAuth expiry across all sandboxes. Non-OAuth entries
   * don't rotate, so any copy is equivalent.
   */
  private async aggregateOpencodeAuth(
    sandboxAuths: { sandboxId: string; content: string; mtime: number }[],
    runningSandboxes: { id: string }[],
  ): Promise<void> {
    const parsed: { sandboxId: string; auth: AuthJson }[] = [];
    for (const { sandboxId, content } of sandboxAuths) {
      try {
        const auth = JSON.parse(content) as AuthJson;
        parsed.push({ sandboxId, auth });
      } catch {
        log.debug({ sandboxId }, "Failed to parse auth.json from sandbox");
      }
    }
    if (parsed.length === 0) return;

    const bestAuth: AuthJson = {};
    const allKeys = new Set(parsed.flatMap(({ auth }) => Object.keys(auth)));

    for (const key of allKeys) {
      let bestEntry: AuthEntry | null = null;
      let bestExpiry = -1;

      for (const { auth } of parsed) {
        const entry = auth[key];
        if (!entry) continue;

        if (entry.type === "oauth") {
          if (entry.expires > bestExpiry) {
            bestExpiry = entry.expires;
            bestEntry = entry;
          }
        } else if (!bestEntry) {
          bestEntry = entry;
        }
      }

      if (bestEntry) {
        bestAuth[key] = bestEntry;
      }
    }

    const bestContent = JSON.stringify(bestAuth, null, 2);

    const existing = this.sharedAuthRepository.getByProvider("opencode");
    if (existing?.content === bestContent) return;

    this.sharedAuthRepository.upsert("opencode", bestContent, "sandbox");
    log.info(
      { keys: [...allKeys] },
      "Auth aggregated from sandboxes and stored in DB",
    );

    const staleSandboxIds = new Set<string>();
    const readSandboxIds = new Set(sandboxAuths.map((a) => a.sandboxId));

    for (const { sandboxId, content } of sandboxAuths) {
      if (content !== bestContent) {
        staleSandboxIds.add(sandboxId);
      }
    }
    for (const sandbox of runningSandboxes) {
      if (!readSandboxIds.has(sandbox.id)) {
        staleSandboxIds.add(sandbox.id);
      }
    }

    if (staleSandboxIds.size === 0) return;

    const staleSandboxIdList = [...staleSandboxIds];
    await this.pushAuthFilesToSandboxes(staleSandboxIdList, [
      { path: VM_PATHS.opencodeAuth, content: bestContent },
    ]);
  }

  private async aggregateOpaqueAuth(
    providerConfig: (typeof AUTH_PROVIDERS)[number],
    sandboxAuths: { sandboxId: string; content: string; mtime: number }[],
    runningSandboxes: { id: string }[],
  ): Promise<void> {
    const newest = sandboxAuths.reduce((best, current) =>
      current.mtime > best.mtime ? current : best,
    );

    const existing = this.sharedAuthRepository.getByProvider(
      providerConfig.name,
    );
    if (existing?.content === newest.content) return;

    this.sharedAuthRepository.upsert(
      providerConfig.name,
      newest.content,
      "sandbox",
    );
    log.info(
      { provider: providerConfig.name, source: newest.sandboxId },
      "Auth synced from sandbox to DB (last edit wins)",
    );

    const staleSandboxIds = runningSandboxes
      .filter((sandbox) => {
        const match = sandboxAuths.find((a) => a.sandboxId === sandbox.id);
        return !match || match.content !== newest.content;
      })
      .map((s) => s.id);

    if (staleSandboxIds.length === 0) return;

    await this.pushAuthFilesToSandboxes(staleSandboxIds, [
      { path: providerConfig.path, content: newest.content },
    ]);
  }

  private async pushAuthFilesToSandboxes(
    sandboxIds: string[],
    files: { path: string; content: string }[],
  ): Promise<void> {
    const commands = files.map((file, i) => ({
      id: `auth-${i}`,
      command: `mkdir -p "$(dirname '${file.path}')" && cat > '${file.path}.tmp' << 'AUTHEOF'\n${file.content}\nAUTHEOF\nmv '${file.path}.tmp' '${file.path}'`,
      timeout: 5000,
    }));

    const results = await Promise.allSettled(
      sandboxIds.map((sandboxId) =>
        this.agentClient.batchExec(sandboxId, commands, { timeout: 10000 }),
      ),
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      log.warn(
        { failures: failures.length, total: results.length },
        "Some auth pushes to sandboxes failed",
      );
    } else {
      log.debug(
        { sandboxes: sandboxIds.length, files: files.length },
        "Auth pushed to sandboxes",
      );
    }
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

    const runningSandboxes = this.sandboxService
      .getAll()
      .filter((s) => s.status === "running");
    if (runningSandboxes.length === 0) return { synced };

    const filesToPush: { path: string; content: string }[] = [];
    for (const auth of storedAuth) {
      const providerConfig = AUTH_PROVIDERS.find(
        (p) => p.name === auth.provider,
      );
      if (!providerConfig) continue;
      filesToPush.push({ path: providerConfig.path, content: auth.content });
      synced++;
    }

    if (filesToPush.length > 0) {
      await this.pushAuthFilesToSandboxes(
        runningSandboxes.map((s) => s.id),
        filesToPush,
      );
    }

    log.info(
      { synced, sandboxes: runningSandboxes.length },
      "Auth sync complete",
    );
    return { synced };
  }

  async syncConfigsToSandboxes(): Promise<{ synced: number }> {
    const globalConfigs = this.configFileService.list({ scope: "global" });
    const workspaceConfigs = this.configFileService.list({
      scope: "workspace",
    });

    const runningSandboxes = this.sandboxService
      .getAll()
      .filter((s) => s.status === "running");
    if (runningSandboxes.length === 0) return { synced: 0 };

    const allConfigs = [...globalConfigs, ...workspaceConfigs];
    const filesToPush: { path: string; content: string }[] = [];

    for (const cfg of allConfigs) {
      const vmPath = this.getVmPathForConfig(cfg.path);
      if (!vmPath) {
        log.debug({ path: cfg.path }, "No VM path mapping found for config");
        continue;
      }
      filesToPush.push({ path: vmPath, content: cfg.content });
    }

    if (filesToPush.length === 0) return { synced: 0 };

    await this.pushConfigFilesToSandboxes(
      runningSandboxes.map((s) => s.id),
      filesToPush,
    );

    log.info(
      { synced: filesToPush.length, sandboxes: runningSandboxes.length },
      "Config sync complete",
    );
    return { synced: filesToPush.length };
  }

  private async pushConfigFilesToSandboxes(
    sandboxIds: string[],
    files: { path: string; content: string }[],
  ): Promise<void> {
    const commands = files.map((file, i) => ({
      id: `config-${i}`,
      command: `mkdir -p "$(dirname '${file.path}')" && cat > '${file.path}.tmp' << 'CONFIGEOF'\n${file.content}\nCONFIGEOF\nmv '${file.path}.tmp' '${file.path}'`,
      timeout: 5000,
    }));

    const results = await Promise.allSettled(
      sandboxIds.map((sandboxId) =>
        this.agentClient.batchExec(sandboxId, commands, { timeout: 10000 }),
      ),
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      log.warn(
        { failures: failures.length, total: results.length },
        "Some config pushes to sandboxes failed",
      );
    }
  }

  async syncRegistryToSandboxes(enabled: boolean): Promise<{ synced: number }> {
    const runningSandboxes = this.sandboxService
      .getAll()
      .filter((s) => s.status === "running");
    if (runningSandboxes.length === 0) return { synced: 0 };

    const sandboxIds = runningSandboxes.map((s) => s.id);

    if (enabled) {
      const registryUrl = RegistryService.getRegistryUrl();
      const bridgeIp = config.network.bridgeIp;

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
          path: "/home/dev/.bunfig.toml",
          content: `[install]\nregistry = "${registryUrl}"`,
        },
        {
          path: "/home/dev/.yarnrc.yml",
          content: `npmRegistryServer: "${registryUrl}"\nunsafeHttpWhitelist:\n  - "${bridgeIp}"`,
        },
      ];

      await this.pushRegistryFilesToSandboxes(sandboxIds, files);
    } else {
      const commands = [
        {
          id: "registry-remove",
          command:
            "rm -f /etc/profile.d/registry.sh /etc/npmrc /home/dev/.bunfig.toml /home/dev/.yarnrc.yml",
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

  private async pushRegistryFilesToSandboxes(
    sandboxIds: string[],
    files: { path: string; content: string }[],
  ): Promise<void> {
    const commands = files.map((file, i) => ({
      id: `registry-${i}`,
      command: `mkdir -p "$(dirname '${file.path}')" && cat > '${file.path}.tmp' << 'REGISTRYEOF'\n${file.content}\nREGISTRYEOF\nmv '${file.path}.tmp' '${file.path}'`,
      timeout: 5000,
    }));

    const results = await Promise.allSettled(
      sandboxIds.map((sandboxId) =>
        this.agentClient.batchExec(sandboxId, commands, { timeout: 10000 }),
      ),
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      log.warn(
        { failures: failures.length, total: results.length },
        "Some registry pushes to sandboxes failed",
      );
    } else {
      log.debug(
        { sandboxes: sandboxIds.length, files: files.length },
        "Registry config pushed to sandboxes",
      );
    }
  }

  private getVmPathForConfig(configPath: string): string | null {
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
