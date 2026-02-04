import type { SandboxConfig } from "@frak-sandbox/shared";
import { AUTH_PROVIDERS, VM_PATHS } from "@frak-sandbox/shared/constants";
import type { AgentClient } from "../../infrastructure/agent/agent.client.ts";
import { RegistryService } from "../../infrastructure/registry/index.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { ConfigFileService } from "../config-file/config-file.service.ts";
import type { SandboxRepository } from "../sandbox/index.ts";
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
    private readonly sandboxService: SandboxRepository,
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
   * DB is truth — sandboxes can only update or add keys, never remove them.
   * OAuth: freshest expiry wins. Non-OAuth: sandbox copy preferred.
   */
  private async aggregateOpencodeAuth(
    sandboxAuths: { sandboxId: string; content: string; mtime: number }[],
    runningSandboxes: { id: string }[],
  ): Promise<void> {
    const dbAuth: AuthJson = this.parseDbAuth();
    const bestAuth: AuthJson = { ...dbAuth };

    for (const { sandboxId, content } of sandboxAuths) {
      let auth: AuthJson;
      try {
        const raw = JSON.parse(content);
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        auth = raw as AuthJson;
      } catch {
        log.debug({ sandboxId }, "Failed to parse auth.json from sandbox");
        continue;
      }

      for (const [key, entry] of Object.entries(auth)) {
        if (!entry) continue;
        const current = bestAuth[key];

        if (
          entry.type === "oauth" &&
          current?.type === "oauth" &&
          entry.expires <= current.expires
        ) {
          continue;
        }

        bestAuth[key] = entry;
      }
    }

    const bestContent = JSON.stringify(bestAuth, null, 2);

    const existing = this.sharedAuthRepository.getByProvider("opencode");
    if (existing?.content === bestContent) return;

    this.sharedAuthRepository.upsert("opencode", bestContent, "sandbox");
    log.info(
      { keys: Object.keys(bestAuth) },
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
    await this.pushFilesToSandboxes(
      staleSandboxIdList,
      [{ path: VM_PATHS.opencodeAuth, content: bestContent }],
      "auth",
    );
  }

  private parseDbAuth(): AuthJson {
    const record = this.sharedAuthRepository.getByProvider("opencode");
    if (!record) return {};
    try {
      const raw = JSON.parse(record.content);
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return raw as AuthJson;
      }
    } catch {
      log.warn("Failed to parse existing DB auth.json, starting fresh");
    }
    return {};
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

    await this.pushFilesToSandboxes(
      staleSandboxIds,
      [{ path: providerConfig.path, content: newest.content }],
      "auth",
    );
  }

  private async pushFilesToSandboxes(
    sandboxIds: string[],
    files: { path: string; content: string; owner?: "dev" | "root" }[],
    label: string,
  ): Promise<void> {
    const fileWrites = files.map((f) => ({
      path: f.path,
      content: f.content,
      owner: f.owner ?? ("dev" as const),
    }));

    const results = await Promise.allSettled(
      sandboxIds.map((sandboxId) =>
        this.agentClient.writeFiles(sandboxId, fileWrites),
      ),
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      log.warn(
        { label, failures: failures.length, total: results.length },
        "Some file pushes to sandboxes failed",
      );
    } else {
      log.debug(
        { label, sandboxes: sandboxIds.length, files: files.length },
        "Files pushed to sandboxes",
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
    const runningSandboxes = this.sandboxService
      .getAll()
      .filter((s) => s.status === "running");
    if (runningSandboxes.length === 0) return { synced: 0 };

    const { files, synced } = this.getAuthFilesToPush();
    if (files.length === 0) return { synced: 0 };

    await this.pushFilesToSandboxes(
      runningSandboxes.map((s) => s.id),
      files,
      "auth",
    );

    log.info(
      { synced, sandboxes: runningSandboxes.length },
      "Auth sync complete",
    );
    return { synced };
  }

  /**
   * Push stored auth directly to a specific sandbox by ID.
   * Used at spawn time when the sandbox isn't yet marked "running".
   */
  async syncAuthToSandbox(sandboxId: string): Promise<{ synced: number }> {
    const { files, synced } = this.getAuthFilesToPush();
    if (files.length === 0) return { synced: 0 };

    await this.pushFilesToSandboxes([sandboxId], files, "auth");
    log.info({ synced, sandboxId }, "Auth pushed to sandbox");
    return { synced };
  }

  private getAuthFilesToPush(): {
    files: { path: string; content: string }[];
    synced: number;
  } {
    const storedAuth = this.sharedAuthRepository.list();
    const files: { path: string; content: string }[] = [];
    let synced = 0;

    for (const auth of storedAuth) {
      const providerConfig = AUTH_PROVIDERS.find(
        (p) => p.name === auth.provider,
      );
      if (!providerConfig) continue;
      files.push({ path: providerConfig.path, content: auth.content });
      synced++;
    }

    return { files, synced };
  }

  async syncConfigsToSandboxes(): Promise<{ synced: number }> {
    const runningSandboxes = this.sandboxService
      .getAll()
      .filter((s) => s.status === "running");
    if (runningSandboxes.length === 0) return { synced: 0 };

    // Group sandboxes by workspace so each gets the right config files
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

      await this.pushFilesToSandboxes(sandboxIds, files, "config");
      totalSynced += files.length;
    }

    log.info(
      { synced: totalSynced, sandboxes: runningSandboxes.length },
      "Config sync complete",
    );
    return { synced: totalSynced };
  }

  /**
   * Push both auth and config files to a sandbox in parallel.
   * Used by spawner, prebuild runner, and lifecycle on start.
   */
  async syncToSandbox(
    sandboxId: string,
  ): Promise<{ auth: { synced: number }; configs: { synced: number } }> {
    const [authResult, configResult] = await Promise.allSettled([
      this.syncAuthToSandbox(sandboxId),
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

    await this.pushFilesToSandboxes([sandboxId], files, "config");
    log.info({ synced: files.length, sandboxId }, "Configs pushed to sandbox");
    return { synced: files.length };
  }

  private getConfigFilesToPush(workspaceId?: string): {
    files: { path: string; content: string }[];
  } {
    // Paths managed by shared_auth must never be pushed via config files
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

      await this.pushFilesToSandboxes(sandboxIds, files, "registry");
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

  private getVmPathForConfig(configPath: string): string | null {
    if (configPath.startsWith("~/")) {
      return `/home/dev/${configPath.slice(2)}`;
    }
    if (configPath.startsWith("/")) {
      return configPath;
    }
    return null;
  }

  async pushSandboxConfig(
    sandboxId: string,
    sandboxConfig: SandboxConfig,
  ): Promise<void> {
    await this.agentClient.setConfig(sandboxId, sandboxConfig);
    log.debug({ sandboxId }, "Sandbox config pushed via setConfig");
  }

  async setHostname(sandboxId: string, hostname: string): Promise<void> {
    const cmd = `hostname "${hostname}" && echo "${hostname}" > /etc/hostname`;
    const result = await this.agentClient.exec(sandboxId, cmd, {
      timeout: 5000,
    });

    if (result.exitCode !== 0) {
      log.warn(
        { sandboxId, exitCode: result.exitCode, stderr: result.stderr },
        "Failed to set hostname",
      );
    } else {
      log.debug({ sandboxId, hostname }, "Hostname set");
    }
  }

  async pushSecrets(sandboxId: string, envFileContent: string): Promise<void> {
    if (!envFileContent) return;

    await this.agentClient.writeFiles(sandboxId, [
      {
        path: "/etc/sandbox/secrets/.env",
        content: envFileContent,
        mode: "0600",
        owner: "root",
      },
    ]);
    log.debug({ sandboxId }, "Secrets pushed");
  }

  async pushGitCredentials(
    sandboxId: string,
    credentials: string[],
  ): Promise<void> {
    if (credentials.length === 0) return;

    const gitCredentialsContent = `${credentials.join("\n")}\n`;
    const gitconfigContent = `[credential]
\thelper = store --file=/etc/sandbox/secrets/git-credentials
[user]
\temail = sandbox@frak.dev
\tname = Sandbox User
`;

    await this.agentClient.writeFiles(sandboxId, [
      {
        path: "/etc/sandbox/secrets/git-credentials",
        content: gitCredentialsContent,
        mode: "0600",
        owner: "dev",
      },
      {
        path: "/home/dev/.gitconfig",
        content: gitconfigContent,
        owner: "dev",
      },
    ]);
    log.debug(
      { sandboxId, credentialCount: credentials.length },
      "Git credentials pushed",
    );
  }

  async pushFileSecrets(
    sandboxId: string,
    fileSecrets: { path: string; content: string; mode?: string }[],
  ): Promise<void> {
    if (fileSecrets.length === 0) return;

    const files = fileSecrets.map((secret) => ({
      path: secret.path.replace(/^~/, "/home/dev"),
      content: secret.content,
      mode: secret.mode || "0600",
      owner: "dev" as const,
    }));

    await this.agentClient.writeFiles(sandboxId, files);
    log.debug({ sandboxId, fileCount: files.length }, "File secrets pushed");
  }

  async pushOhMyOpenCodeCache(
    sandboxId: string,
    providers: string[],
  ): Promise<void> {
    const cacheContent = JSON.stringify(
      {
        connected: providers,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    );

    await this.agentClient.writeFiles(sandboxId, [
      {
        path: "/home/dev/.cache/oh-my-opencode/connected-providers.json",
        content: cacheContent,
        owner: "dev",
      },
    ]);
    log.debug({ sandboxId, providers }, "OhMyOpenCode cache pushed");
  }

  async pushSandboxMd(sandboxId: string, content: string): Promise<void> {
    await this.agentClient.writeFiles(sandboxId, [
      {
        path: "/home/dev/SANDBOX.md",
        content,
        owner: "dev",
      },
    ]);
    log.debug({ sandboxId }, "SANDBOX.md pushed");
  }

  /**
   * Configure network inside the sandbox via agent exec.
   * Called post-boot for both fresh spawns and snapshot restores.
   */
  async configureNetwork(
    sandboxId: string,
    network: { ipAddress: string; gateway: string },
  ): Promise<void> {
    const dnsServers = config.network.dnsServers;
    const dnsCommands = dnsServers
      .map((dns) => `echo 'nameserver ${dns}' >> /etc/resolv.conf`)
      .join(" && ");

    const networkCmd = `ip addr add ${network.ipAddress}/24 dev eth0 && ip link set eth0 up && ip route add default via ${network.gateway} dev eth0 && > /etc/resolv.conf && ${dnsCommands}`;

    const result = await this.agentClient.exec(sandboxId, networkCmd, {
      timeout: 10000,
    });

    if (result.exitCode !== 0) {
      log.error(
        { sandboxId, exitCode: result.exitCode, stderr: result.stderr },
        "Network configuration failed",
      );
      throw new Error(`Network configuration failed: ${result.stderr}`);
    }

    log.info({ sandboxId, ipAddress: network.ipAddress }, "Network configured");
  }

  /**
   * Push registry configuration to a single sandbox.
   */
  async pushRegistryConfigToSandbox(sandboxId: string): Promise<void> {
    const settings = RegistryService.getSettings();
    if (!settings.enabled) return;

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

    await this.pushFilesToSandboxes([sandboxId], files, "registry");
    log.debug({ sandboxId }, "Registry config pushed");
  }

  /**
   * Start services in the sandbox via agent endpoints.
   */
  async startServices(
    sandboxId: string,
    serviceNames: string[],
  ): Promise<void> {
    await Promise.all(
      serviceNames.map((name) =>
        this.agentClient.serviceStart(sandboxId, name).catch((err) => {
          log.warn(
            { sandboxId, service: name, error: String(err) },
            "Service start failed (non-blocking)",
          );
        }),
      ),
    );
    log.info({ sandboxId, services: serviceNames }, "Services started");
  }

  /**
   * Push all configuration to a sandbox post-boot.
   * This is the main entry point for spawner post-boot configuration.
   */
  async syncAllToSandbox(
    sandboxId: string,
  ): Promise<{
    auth: { synced: number };
    configs: { synced: number };
    registry: boolean;
  }> {
    const [authConfigs, registry] = await Promise.all([
      this.syncToSandbox(sandboxId),
      this.pushRegistryConfigToSandbox(sandboxId)
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
