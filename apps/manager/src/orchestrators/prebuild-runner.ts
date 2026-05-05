import { VM } from "@frak/atelier-shared/constants";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { $ } from "bun";
import type { AgentClient } from "../infrastructure/agent/index.ts";
import { eventBus } from "../infrastructure/events/index.ts";
import {
  buildConfigMap,
  buildPvc,
  buildSandboxPod,
  buildVolumeSnapshot,
  type KubeClient,
} from "../infrastructure/kubernetes/index.ts";
import { RegistryService } from "../infrastructure/registry/index.ts";
import type { InternalService } from "../modules/internal/index.ts";
import type { SystemAiService } from "../modules/system-sandbox/index.ts";

import type { UserService } from "../modules/user/index.ts";
import type { WorkspaceService } from "../modules/workspace/index.ts";
import type {
  PrebuildStatus,
  RepoConfig,
  Workspace,
  WorkspaceConfig,
} from "../schemas/index.ts";
import { config, isMock } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { buildOpenCodeAuthHeaders } from "../shared/lib/opencode-auth.ts";
import { GuestOps } from "./ports/guest-ops.ts";

const log = createChildLogger("prebuild-runner");

/**
 * Internal key used to namespace system-level prebuild resources (PVC, pod,
 * snapshot). It's a string identifier, NOT a workspace id — system sandboxes
 * have `workspaceId: undefined` and `origin.source: "system"`.
 *
 * The literal `"__system__"` is kept for snapshot-name backward compat: the
 * snapshot is named `prebuild-${normalize(key)}` which resolves to
 * `prebuild-system` either way.
 */
const SYSTEM_KEY = "__system__";

const POLL_INTERVAL_MS = 2000;
// const POD_TIMEOUT_MS = 120_000;
const AGENT_TIMEOUT_MS = 60_000;
const SNAPSHOT_TIMEOUT_MS = 300_000;
const INIT_COMMAND_TIMEOUT_MS = 300_000;
const OPENCODE_HEALTH_TIMEOUT_MS = 120_000;
const OPENCODE_WARMUP_PORT = 4200;
const GIT_TOKEN_PLACEHOLDER = "$" + "{GIT_TOKEN}";
const MAX_PREBUILD_RETRIES = 5;
const RETRY_DELAY_MS = 5_000;

export type PrebuildScenario =
  | {
      kind: "workspace";
      workspaceId: string;
      getWorkspace: () => Workspace | undefined;
      updateStatus: (
        status: PrebuildStatus,
        latestId?: string,
        commitHashes?: Record<string, string>,
        errorMessage?: string,
      ) => void;
      aiService?: SystemAiService;
    }
  | { kind: "system" };

export interface PrebuildRunnerDependencies {
  workspaceService: WorkspaceService;
  userService: UserService;
  kubeClient: KubeClient;
  agentClient: AgentClient;
  internalService: InternalService;
  aiService?: SystemAiService;
}

type ActiveBuild = { podName: string; pvcName: string };

export class PrebuildRunner {
  protected readonly activeBuilds = new Map<string, ActiveBuild>();

  constructor(protected readonly deps: PrebuildRunnerDependencies) {}

  async run(workspaceId?: string): Promise<void> {
    if (!workspaceId) throw new Error("Workspace ID is required");

    const workspace = this.deps.workspaceService.getById(workspaceId);
    if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_PREBUILD_RETRIES; attempt++) {
      try {
        await this.runScenario({
          kind: "workspace",
          workspaceId,
          getWorkspace: () => this.deps.workspaceService.getById(workspaceId),
          updateStatus: (status, latestId, commitHashes, errorMessage) => {
            const current = this.deps.workspaceService.getById(workspaceId);
            if (!current) return;
            this.updatePrebuildStatus(
              workspaceId,
              current,
              status,
              latestId,
              commitHashes,
              errorMessage,
            );
          },
          aiService: this.deps.aiService,
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < MAX_PREBUILD_RETRIES) {
          log.warn(
            { workspaceId, attempt, maxRetries: MAX_PREBUILD_RETRIES, error },
            "Prebuild failed, retrying",
          );
          await Bun.sleep(RETRY_DELAY_MS);
        }
      }
    }

    throw lastError;
  }

  async runSystem(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_PREBUILD_RETRIES; attempt++) {
      try {
        await this.runScenario({ kind: "system" });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < MAX_PREBUILD_RETRIES) {
          log.warn(
            { attempt, maxRetries: MAX_PREBUILD_RETRIES, error },
            "System prebuild failed, retrying",
          );
          await Bun.sleep(RETRY_DELAY_MS);
        }
      }
    }

    throw lastError;
  }

  runInBackground(workspaceId?: string): void {
    setImmediate(() => {
      this.run(workspaceId).catch((error) => {
        log.error({ workspaceId, error }, "Background prebuild failed");
      });
    });
  }

  runSystemInBackground(): void {
    setImmediate(() => {
      this.runSystem().catch((error) => {
        log.error({ error }, "Background system prebuild failed");
      });
    });
  }

  async cancel(workspaceId?: string): Promise<void> {
    if (!workspaceId) throw new Error("Workspace ID is required");

    const workspace = this.deps.workspaceService.getById(workspaceId);
    if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);

    if (this.activeBuilds.has(workspaceId)) {
      await this.cleanupBuildResources(workspaceId);
      return;
    }

    if (workspace.config.prebuild?.status !== "building") {
      throw new Error(`Workspace '${workspaceId}' has no prebuild to cancel`);
    }

    await this.cleanupBuildResources(workspaceId);
    this.updatePrebuildStatus(workspaceId, workspace, "none");
  }

  async cancelSystem(): Promise<void> {
    if (!this.isSystemBuilding()) {
      throw new Error("No system prebuild in progress to cancel");
    }
    await this.cleanupBuildResources(SYSTEM_KEY);
  }

  async delete(workspaceId?: string): Promise<void> {
    if (!workspaceId) throw new Error("Workspace ID is required");

    const workspace = this.deps.workspaceService.getById(workspaceId);
    if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);

    await this.cleanupStorage(workspaceId);
    this.updatePrebuildStatus(workspaceId, workspace, "none");
  }

  async deleteSystem(): Promise<void> {
    await this.cleanupStorage(SYSTEM_KEY);
  }

  async ensureSystemPrebuild(): Promise<void> {
    const exists = await this.hasPrebuild(SYSTEM_KEY);
    if (exists) {
      log.info("System prebuild snapshot exists, skipping");
      return;
    }
    await this.runSystem();
  }

  async readSystemMetadata(): Promise<{
    latestId: string;
    builtAt: string;
  } | null> {
    const exists = await this.hasPrebuild(SYSTEM_KEY);
    if (!exists) return null;
    return {
      latestId: this.snapshotNameForKey(SYSTEM_KEY),
      builtAt: new Date().toISOString(),
    };
  }

  isBuilding(key?: string): boolean {
    return key ? this.activeBuilds.has(key) : false;
  }

  isSystemBuilding(): boolean {
    return this.activeBuilds.has(SYSTEM_KEY);
  }

  hasSystemPrebuild(): Promise<boolean> {
    return this.hasPrebuild(SYSTEM_KEY);
  }

  async getSystemStatus(): Promise<{
    hasPrebuild: boolean;
    building: boolean;
  }> {
    return {
      hasPrebuild: await this.hasPrebuild(SYSTEM_KEY),
      building: this.isSystemBuilding(),
    };
  }

  async hasPrebuild(key: string): Promise<boolean> {
    if (isMock()) return false;

    const snapshotName = this.snapshotNameForKey(key);
    try {
      const snap = await this.deps.kubeClient.get<{
        status?: { readyToUse?: boolean };
      }>(
        `/apis/snapshot.storage.k8s.io/v1/namespaces/${config.kubernetes.namespace}/volumesnapshots/${snapshotName}`,
      );
      return snap.status?.readyToUse === true;
    } catch {
      return false;
    }
  }

  async cleanupStorage(key: string): Promise<void> {
    if (isMock()) return;

    const snapshotName = this.snapshotNameForKey(key);
    try {
      await this.deps.kubeClient.deleteResource(
        "VolumeSnapshot",
        snapshotName,
        config.kubernetes.namespace,
      );
      log.info({ key, snapshotName }, "Deleted prebuild snapshot");
    } catch {
      log.debug({ key, snapshotName }, "No snapshot to delete");
    }
  }

  // ---------------------------------------------------------------------------
  // Core scenario runner
  // ---------------------------------------------------------------------------

  private async runScenario(scenario: PrebuildScenario): Promise<void> {
    const key =
      scenario.kind === "workspace" ? scenario.workspaceId : SYSTEM_KEY;
    if (this.activeBuilds.has(key)) {
      throw new Error(
        scenario.kind === "workspace"
          ? `Workspace '${scenario.workspaceId}' already has a prebuild in progress`
          : "System prebuild already in progress",
      );
    }

    if (scenario.kind === "workspace") {
      const workspace = this.requireWorkspace(scenario);
      if (workspace.config.prebuild?.status === "building") {
        throw new Error(
          `Workspace '${scenario.workspaceId}' already has a prebuild in progress`,
        );
      }
      scenario.updateStatus("building");
    }

    const namespace = config.kubernetes.namespace;
    const resourceName = this.resourceNameForKey(key);
    const pvcName = resourceName;
    const podName = resourceName;
    const configMapName = `${resourceName}-config`;
    this.activeBuilds.set(key, { podName, pvcName });
    const labelValue = this.normalizeKey(key);

    try {
      if (isMock()) {
        if (scenario.kind === "workspace") {
          const workspace = this.requireWorkspace(scenario);
          const commitHashes = await this.captureCommitHashes(workspace);
          const snapshotName = this.snapshotNameForKey(key);
          scenario.updateStatus("ready", snapshotName, commitHashes);
        }
        return;
      }

      // Pre-flight: verify snapshot capability
      await this.verifySnapshotCapability();

      // Step 1: Create temp PVC
      const volumeSize = config.kubernetes.defaultVolumeSize;
      log.info({ key, pvcName, volumeSize }, "Creating prebuild PVC");

      await this.deps.kubeClient.createResource(
        buildPvc({
          name: pvcName,
          namespace,
          size: volumeSize,
          labels: { "atelier.dev/prebuild": labelValue },
        }),
        namespace,
      );

      // Note: no waitForPvcBound — local-path uses WaitForFirstConsumer,
      // so the PVC binds only when a pod referencing it is scheduled.
      // Step 2: Spawn temp pod with base image + PVC at /home/dev
      const image = this.resolveBaseImage(scenario);
      const sandboxId = resourceName;
      log.info({ key, podName, image }, "Spawning prebuild pod");

      await this.deps.kubeClient.createResource(
        buildConfigMap(
          configMapName,
          { "config.json": JSON.stringify({ prebuild: true }) },
          namespace,
          { "atelier.dev/prebuild": labelValue },
        ),
        namespace,
      );

      // Use workspace resource config if available, with generous defaults for prebuild
      const memoryMb =
        scenario.kind === "workspace"
          ? Math.max(
              this.requireWorkspace(scenario).config.memoryMb ?? 4096,
              4096,
            )
          : 4096;
      const memoryLimit = `${memoryMb}Mi`;
      const cpuLimit = memoryMb >= 8192 ? "4000m" : "2000m";

      await this.deps.kubeClient.createResource(
        buildSandboxPod({
          sandboxId,
          image,
          opencodePassword: "prebuild",
          pvcName,
          configMapName,
          namespace,
          requests: { cpu: "500m", memory: "2Gi" },
          limits: { cpu: cpuLimit, memory: memoryLimit },
        }),
        namespace,
      );

      // Step 3: Wait for pod + agent ready
      // Single wait: agent health check implies pod is ready and has an IP
      const { ready: agentReady } = await this.deps.agentClient.waitForAgent(
        sandboxId,
        {
          timeout: AGENT_TIMEOUT_MS,
        },
      );
      if (!agentReady) {
        throw new Error(`Agent in prebuild pod ${podName} did not start`);
      }

      // Step 4: Run prebuild steps via agent
      const commitHashes = await this.runPrebuildSteps(sandboxId, scenario);

      // Flush writes to PVC before snapshot
      log.info({ key }, "Flushing writes before snapshot");
      await this.deps.agentClient.exec(sandboxId, "sync", {
        timeout: 10_000,
      });

      // Step 5: Stop the pod (to flush writes)
      log.info({ key, podName }, "Stopping prebuild pod before snapshot");
      try {
        await this.deps.kubeClient.deleteResource(
          "Pod",
          `sandbox-${sandboxId}`,
          namespace,
        );
      } catch (error) {
        log.warn({ key, error }, "Failed to stop prebuild pod");
      }

      // Wait for pod to terminate
      await this.waitForPodTermination(`sandbox-${sandboxId}`, namespace);

      // Step 6: Create VolumeSnapshot from temp PVC
      const snapshotName = this.snapshotNameForKey(key);
      log.info({ key, snapshotName, pvcName }, "Creating VolumeSnapshot");

      try {
        await this.deps.kubeClient.deleteResource(
          "VolumeSnapshot",
          snapshotName,
          namespace,
        );
        await Bun.sleep(2000);
      } catch {}

      await this.deps.kubeClient.createResource(
        buildVolumeSnapshot({
          name: snapshotName,
          namespace,
          pvcName,
          labels: { "atelier.dev/prebuild": labelValue },
        }),
        namespace,
      );

      // Step 7: Wait for snapshot ready
      const snapReady = await this.deps.kubeClient.waitForVolumeSnapshotReady(
        snapshotName,
        { timeout: SNAPSHOT_TIMEOUT_MS, namespace },
      );
      if (!snapReady) {
        throw new Error(`VolumeSnapshot ${snapshotName} did not become ready`);
      }

      log.info({ key, snapshotName }, "Prebuild snapshot ready");

      // Step 8: Update status
      if (scenario.kind === "workspace") {
        scenario.updateStatus("ready", snapshotName, commitHashes);

        const ws = scenario.getWorkspace();
        if (ws) {
          scenario.aiService?.generateDescriptionInBackground(
            ws,
            "updated",
            (description) => {
              this.deps.workspaceService.update(scenario.workspaceId, {
                config: { description },
              });
            },
          );
        }
      }
    } catch (error) {
      if (scenario.kind === "workspace") {
        const workspace = scenario.getWorkspace();
        const message = error instanceof Error ? error.message : String(error);
        if (workspace)
          scenario.updateStatus("failed", undefined, undefined, message);
      }
      throw error;
    } finally {
      await this.cleanupBuildResources(key);
      this.activeBuilds.delete(key);
    }
  }

  // ---------------------------------------------------------------------------
  // Prebuild steps (run inside the temp pod via agent)
  // ---------------------------------------------------------------------------

  private async runPrebuildSteps(
    sandboxId: string,
    scenario: PrebuildScenario,
  ): Promise<Record<string, string>> {
    const agent = this.deps.agentClient;
    const githubToken = this.deps.userService.resolveGitHubToken();
    let commitHashes: Record<string, string> = {};

    // Point npm/bun/yarn at our Verdaccio cache before any install runs.
    // Without this, both `initCommands` and OpenCode's plugin install during
    // warmup go to the public npm registry — which is the main reason
    // `oh-my-openagent@x.y.z` takes ~13s instead of <1s on a warm cache.
    await this.pushRegistryConfig(sandboxId);

    // Push merged workspace/system config files (opencode.json with plugin
    // definitions, MCP server, CLIProxy provider, etc.) into the prebuild
    // pod. Without this, OpenCode warmup boots blind: it never sees external
    // plugins like `oh-my-openagent`, never downloads them into
    // ~/.cache/opencode/packages, and the snapshot ships cold — every
    // runtime sandbox then pays the full plugin install cost on first use.
    await this.pushWorkspaceConfigs(sandboxId, scenario);

    if (scenario.kind === "workspace") {
      const workspace = this.requireWorkspace(scenario);

      // Clone repositories
      if (workspace.config.repos?.length) {
        for (const repo of workspace.config.repos) {
          await GuestOps.cloneRepository(agent, sandboxId, repo, githubToken);
        }

        // Sanitize git URLs (remove tokens from remote)
        await GuestOps.sanitizeGitRemoteUrls(
          agent,
          sandboxId,
          workspace.config.repos,
        );

        // Capture commit hashes from inside the pod
        commitHashes = await this.captureCommitHashesFromPod(
          sandboxId,
          workspace,
        );
      }

      // Write secrets and file secrets (needed by init commands)
      const [secretFiles, gitCredFiles, fileSecretFiles] = await Promise.all([
        GuestOps.collectSecretFiles(workspace),
        GuestOps.collectGitCredentialFiles(githubToken),
        GuestOps.collectFileSecretFiles(workspace),
      ]);
      const allFiles = [...secretFiles, ...gitCredFiles, ...fileSecretFiles];
      if (allFiles.length > 0) {
        log.info(
          { sandboxId, fileCount: allFiles.length },
          "Writing secrets to prebuild pod",
        );
        await agent.writeFiles(sandboxId, allFiles);
      }

      // Run init commands
      for (const command of workspace.config.initCommands) {
        log.info({ sandboxId, command }, "Running init command");
        const result = await agent.exec(sandboxId, command, {
          timeout: INIT_COMMAND_TIMEOUT_MS,
          user: "dev",
          workdir: VM.WORKSPACE_DIR,
        });
        if (result.exitCode !== 0) {
          throw new Error(`Init command failed: ${command}\n${result.stderr}`);
        }
      }

      // Fix ownership after init commands
      log.info({ sandboxId }, "Fixing workspace ownership");
      await agent.exec(sandboxId, `chown -R dev:dev ${VM.WORKSPACE_DIR}`, {
        timeout: INIT_COMMAND_TIMEOUT_MS,
      });
    }

    // OpenCode warmup (both workspace and system)
    const bootstrapDirs = this.resolveWarmupDirs(scenario);
    await this.warmupOpencode(sandboxId, bootstrapDirs);

    return commitHashes;
  }

  /**
   * Push Verdaccio registry config so npm/bun/yarn use the cluster cache
   * instead of the public npm registry. Best-effort: if Verdaccio is down,
   * we silently fall back to the public registry rather than failing the
   * prebuild.
   */
  private async pushRegistryConfig(sandboxId: string): Promise<void> {
    try {
      const files = await RegistryService.buildRegistryConfigFiles();
      if (!files) {
        log.warn(
          { sandboxId },
          "Verdaccio not reachable, prebuild will hit the public npm registry",
        );
        return;
      }
      await this.deps.agentClient.writeFiles(sandboxId, files);
      log.info(
        { sandboxId, fileCount: files.length },
        "Pushed Verdaccio registry config to prebuild pod",
      );
    } catch (error) {
      log.warn(
        { sandboxId, error: String(error) },
        "Failed to push registry config, continuing with public npm",
      );
    }
  }

  /**
   * Push the workspace's (or system's) merged config files — opencode
   * config, MCP server, CLIProxy provider, plugin manifests — into the
   * prebuild pod so the OpenCode warmup that follows can see external
   * plugins and bake them into the snapshot.
   *
   * Best-effort: a missing config shouldn't fail the prebuild. The runtime
   * sandbox spawn flow re-syncs configs anyway, so the worst case is a
   * cold-start on first use rather than a broken sandbox.
   */
  private async pushWorkspaceConfigs(
    sandboxId: string,
    scenario: PrebuildScenario,
  ): Promise<void> {
    const isSystem = scenario.kind === "system";
    const workspaceId = isSystem ? undefined : scenario.workspaceId;
    try {
      const result = await this.deps.internalService.syncConfigsToSandbox(
        sandboxId,
        {
          workspaceId,
          ...(isSystem && { origin: { source: "system" } }),
        },
      );
      log.info(
        { sandboxId, workspaceId, synced: result.synced },
        "Pushed workspace configs to prebuild pod",
      );
    } catch (error) {
      log.warn(
        { sandboxId, workspaceId, error: String(error) },
        "Failed to push workspace configs, opencode warmup may miss plugins",
      );
    }
  }

  private resolveWarmupDirs(scenario: PrebuildScenario): string[] {
    if (scenario.kind === "system") {
      return [VM.HOME];
    }
    const workspace = scenario.getWorkspace();
    const repos = workspace?.config.repos ?? [];
    if (repos.length === 0) {
      return [VM.WORKSPACE_DIR];
    }
    return repos.map((repo) => {
      const clonePath = repo.clonePath.startsWith("/")
        ? repo.clonePath
        : `/${repo.clonePath}`;
      return `${VM.HOME}${clonePath}`;
    });
  }

  /**
   * Bake the per-directory OpenCode caches into the prebuild snapshot.
   *
   * `opencode serve` is just an HTTP control plane: it does not migrate the DB,
   * install plugins, download ripgrep, or initialize the project until a request
   * arrives carrying a `directory=` parameter (which triggers
   * `InstanceMiddleware` -> `InstanceBootstrap.run` in OpenCode). Without that
   * trigger, none of the heavy startup work lands on the PVC and every
   * subsequent sandbox pays the full ~30s cold-start cost on its first request.
   *
   * To populate the snapshot, we boot opencode against the first repo dir as cwd
   * and explicitly call `session.list({ directory })` for every workspace repo,
   * forcing the bootstrap to complete (DB migrations, ripgrep download into
   * ~/.local/share/opencode/bin/, npm install of plugins into
   * ~/.local/share/opencode/plugins/, project .opencode/ init) before we kill
   * the process and snapshot the PVC.
   */
  private async warmupOpencode(
    sandboxId: string,
    bootstrapDirs: string[],
  ): Promise<void> {
    if (bootstrapDirs.length === 0) {
      log.warn(
        { sandboxId },
        "No bootstrap dirs for OpenCode warmup, skipping",
      );
      return;
    }

    const agent = this.deps.agentClient;
    const port = OPENCODE_WARMUP_PORT;
    const namespace = config.kubernetes.namespace;
    const podName = `sandbox-${sandboxId}`;
    const cwd = bootstrapDirs[0] ?? VM.HOME;

    log.info({ sandboxId, bootstrapDirs }, "Warming up OpenCode server");

    // Start opencode in background inside the pod
    const startResult = await agent.exec(
      sandboxId,
      `nohup setsid opencode serve --hostname 0.0.0.0 --port ${port} </dev/null >/tmp/opencode-warmup.log 2>&1 &`,
      { timeout: 10_000, user: "dev", workdir: cwd },
    );
    if (startResult.exitCode !== 0) {
      log.warn(
        { sandboxId, stderr: startResult.stderr },
        "Failed to start OpenCode for warmup, continuing",
      );
      return;
    }

    // Get pod IP to connect to OpenCode endpoints
    let podIp: string | undefined;
    try {
      const pod = await this.deps.kubeClient.get<{
        status?: { podIP?: string };
      }>(`/api/v1/namespaces/${namespace}/pods/${podName}`);
      podIp = pod.status?.podIP;
    } catch {
      log.warn({ sandboxId }, "Failed to get pod IP for warmup health check");
    }

    if (!podIp) {
      await this.killWarmupOpencode(sandboxId);
      return;
    }

    const client = createOpencodeClient({
      baseUrl: `http://${podIp}:${port}`,
      headers: buildOpenCodeAuthHeaders("prebuild"),
    });

    const healthy = await this.waitForWarmupHealth(client, sandboxId);
    if (!healthy) {
      await this.killWarmupOpencode(sandboxId);
      return;
    }

    // Trigger InstanceBootstrap for each workspace dir. This is what installs
    // plugins, downloads ripgrep, applies migrations, and primes the project
    // .opencode/ directory — the work we want baked into the snapshot.
    for (const directory of bootstrapDirs) {
      const ok = await this.bootstrapWarmupDirectory(
        client,
        sandboxId,
        directory,
      );
      if (!ok) {
        log.warn(
          { sandboxId, directory },
          "Directory bootstrap did not complete, snapshot may be cold",
        );
      }
    }

    // Even though `app.agents` and `find.text` returned, OpenCode forks the
    // actual `Npm.add` reify (Arborist install of plugin packages) into a
    // background fiber. Killing the warmup pod too quickly aborts that fiber
    // and the install never lands on disk. Poll the cache until at least one
    // plugin package.json materializes (or we time out).
    await this.waitForPluginsInstalled(sandboxId);

    // Flush page cache to disk before we kill so the snapshot is consistent.
    await agent.exec(sandboxId, "sync", { timeout: 10_000 }).catch(() => {});

    await this.killWarmupOpencode(sandboxId);
    log.info(
      { sandboxId, bootstrapped: bootstrapDirs.length },
      "OpenCode warmup completed",
    );
  }

  /**
   * Poll until external OpenCode plugins have finished installing to
   * `~/.cache/opencode/packages/<spec>/node_modules/<name>/`.
   *
   * `app.agents` returns once the plugin registry resolves in-memory, but the
   * actual npm install (`Npm.add` -> Arborist reify) runs in a forked fiber
   * and may still be writing files when the request completes. We wait for the
   * filesystem to settle before snapshotting; otherwise the cache slot is
   * empty and every sandbox spawned from the snapshot pays the full ~16s
   * `import()` + reify cost on its first request.
   */
  private async waitForPluginsInstalled(sandboxId: string): Promise<void> {
    const POLL_INTERVAL_MS = 2_000;
    const SETTLE_MS = 3_000;
    const TIMEOUT_MS = 90_000;
    // Bail early if no plugin install ever appears — the workspace probably
    // has no external plugins configured, so there's nothing to wait for.
    const NO_PLUGIN_BAIL_MS = 12_000;
    const PROBE = `find /home/dev/.cache/opencode/packages -mindepth 4 -name 'package.json' -type f 2>/dev/null | wc -l`;

    const startTime = Date.now();
    let lastCount = -1;
    let stableSince = 0;
    let everSeenInstall = false;

    while (Date.now() - startTime < TIMEOUT_MS) {
      const result = await this.deps.agentClient
        .exec(sandboxId, PROBE, { timeout: 10_000 })
        .catch(() => ({ exitCode: 1, stdout: "0", stderr: "" }));

      const count = Number.parseInt(result.stdout.trim(), 10) || 0;
      if (count > 0) everSeenInstall = true;

      if (count > 0 && count === lastCount) {
        // Count has been stable across polls — install finished.
        if (Date.now() - stableSince >= SETTLE_MS) {
          log.info(
            {
              sandboxId,
              pluginCount: count,
              waitedMs: Date.now() - startTime,
            },
            "Plugin install settled",
          );
          return;
        }
      } else {
        if (count !== lastCount) {
          log.debug(
            { sandboxId, pluginCount: count },
            "Plugin install progressing",
          );
        }
        lastCount = count;
        stableSince = Date.now();
      }

      // Short-circuit: if nothing has appeared after the bail window, the
      // workspace likely has no external plugins. Don't waste 90s.
      if (!everSeenInstall && Date.now() - startTime >= NO_PLUGIN_BAIL_MS) {
        log.info(
          { sandboxId, waitedMs: Date.now() - startTime },
          "No external plugins detected, skipping plugin install wait",
        );
        return;
      }

      await Bun.sleep(POLL_INTERVAL_MS);
    }

    log.warn(
      { sandboxId, lastPluginCount: lastCount, timeoutMs: TIMEOUT_MS },
      "Timed out waiting for plugin install \u2014 snapshot may not include plugins",
    );
  }

  private async waitForWarmupHealth(
    client: ReturnType<typeof createOpencodeClient>,
    sandboxId: string,
  ): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < OPENCODE_HEALTH_TIMEOUT_MS) {
      try {
        const { data } = await client.global.health();
        if (data?.healthy) {
          log.info({ sandboxId }, "OpenCode server is healthy");
          return true;
        }
      } catch {}
      await Bun.sleep(2_000);
    }
    log.warn(
      { sandboxId },
      "OpenCode did not become healthy within timeout, continuing",
    );
    return false;
  }

  private async bootstrapWarmupDirectory(
    client: ReturnType<typeof createOpencodeClient>,
    sandboxId: string,
    directory: string,
  ): Promise<boolean> {
    log.info(
      { sandboxId, directory },
      "Triggering OpenCode instance bootstrap",
    );
    const startTime = Date.now();

    try {
      // session.list goes through InstanceMiddleware -> InstanceStore.load,
      // which awaits InstanceBootstrap.run. That kicks off DB migrations and
      // calls Plugin.init(). It does NOT block on the actual npm install of
      // plugins or the ripgrep binary download — those are forked async by
      // their respective service init() functions.
      const sessionRes = await client.session.list({ directory, limit: 1 });
      if (sessionRes.error) {
        log.warn(
          { sandboxId, directory, error: String(sessionRes.error) },
          "OpenCode session.list errored during bootstrap",
        );
        return false;
      }

      // Force the plugin install to complete: enumerating agents requires
      // every plugin to be loaded (plugins register agents at load time), so
      // this call cannot return until ~/.config/opencode/node_modules/ is
      // populated.
      const agentsRes = await client.app.agents({ directory });
      if (agentsRes.error) {
        log.warn(
          { sandboxId, directory, error: String(agentsRes.error) },
          "OpenCode app.agents errored during bootstrap",
        );
      }

      // Force the ripgrep download: any text search invokes the rg binary,
      // which the File service downloads on first use into
      // ~/.local/share/opencode/bin/. The pattern is a no-op string we don't
      // expect to match.
      const findRes = await client.find.text({
        directory,
        pattern: "__atelier_warmup__",
      });
      if (findRes.error) {
        log.warn(
          { sandboxId, directory, error: String(findRes.error) },
          "OpenCode find.text errored during ripgrep warmup",
        );
      }

      log.info(
        {
          sandboxId,
          directory,
          totalDurationMs: Date.now() - startTime,
          agentsCount: agentsRes.data?.length ?? 0,
        },
        "OpenCode instance bootstrapped (plugins + ripgrep forced)",
      );
      return true;
    } catch (error) {
      log.warn(
        { sandboxId, directory, error: String(error) },
        "OpenCode instance bootstrap failed",
      );
      return false;
    }
  }

  private async killWarmupOpencode(sandboxId: string): Promise<void> {
    await this.deps.agentClient
      .exec(sandboxId, "pkill -f 'opencode serve'", { timeout: 5_000 })
      .catch(() => {});
  }

  private async captureCommitHashesFromPod(
    sandboxId: string,
    workspace: Workspace,
  ): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    if (!workspace.config.repos?.length) return hashes;

    for (const repo of workspace.config.repos) {
      const clonePath = repo.clonePath.startsWith("/")
        ? repo.clonePath
        : `/${repo.clonePath}`;
      const fullPath = `${VM.HOME}${clonePath}`;

      const result = await this.deps.agentClient.exec(
        sandboxId,
        `git -C ${fullPath} rev-parse HEAD`,
        { timeout: 10_000, user: "dev" },
      );

      if (result.exitCode === 0 && result.stdout.trim()) {
        hashes[repo.clonePath] = result.stdout.trim();
        log.debug(
          {
            workspaceId: workspace.id,
            clonePath: repo.clonePath,
            hash: hashes[repo.clonePath],
          },
          "Captured commit hash",
        );
      } else {
        log.warn(
          {
            workspaceId: workspace.id,
            clonePath: repo.clonePath,
            exitCode: result.exitCode,
          },
          "Failed to capture commit hash",
        );
      }
    }

    return hashes;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async verifySnapshotCapability(): Promise<void> {
    const hasApi = await this.deps.kubeClient.checkSnapshotApi();
    if (!hasApi) {
      throw new Error(
        "Prebuilds require the CSI snapshot controller " +
          "(snapshot.storage.k8s.io API not available). " +
          "Install the snapshot controller and a VolumeSnapshotClass " +
          "to enable prebuilds.",
      );
    }

    const configuredClass = config.kubernetes.volumeSnapshotClass || undefined;
    const hasClass =
      await this.deps.kubeClient.checkVolumeSnapshotClass(configuredClass);
    if (!hasClass) {
      throw new Error(
        configuredClass
          ? `VolumeSnapshotClass '${configuredClass}' not found. ` +
              "Prebuilds cannot proceed without a valid snapshot class."
          : "No VolumeSnapshotClass found in the cluster. " +
              "Create one for your CSI driver to enable prebuilds.",
      );
    }
  }

  private requireWorkspace(
    scenario: Extract<PrebuildScenario, { kind: "workspace" }>,
  ): Workspace {
    const workspace = scenario.getWorkspace();
    if (!workspace) {
      throw new Error(`Workspace '${scenario.workspaceId}' not found`);
    }
    return workspace;
  }

  private async cleanupBuildResources(key: string): Promise<void> {
    if (isMock()) return;

    const namespace = config.kubernetes.namespace;
    const resourceName = this.resourceNameForKey(key);
    const podName = `sandbox-${resourceName}`;
    const pvcName = resourceName;
    const configMapName = `${resourceName}-config`;

    for (const [kind, name] of [
      ["Pod", podName],
      ["ConfigMap", configMapName],
      ["PersistentVolumeClaim", pvcName],
    ] as const) {
      try {
        await this.deps.kubeClient.deleteResource(kind, name, namespace);
      } catch {
        log.debug({ kind, name }, "Failed to cleanup prebuild resource");
      }
    }
  }

  private async waitForPodTermination(
    podName: string,
    namespace: string,
  ): Promise<void> {
    const startedAt = Date.now();
    const timeout = 60_000;

    while (Date.now() - startedAt < timeout) {
      try {
        await this.deps.kubeClient.get(
          `/api/v1/namespaces/${namespace}/pods/${podName}`,
        );
        await Bun.sleep(POLL_INTERVAL_MS);
      } catch {
        return;
      }
    }

    log.warn({ podName }, "Pod did not terminate within timeout");
  }

  private resolveBaseImage(scenario: PrebuildScenario): string {
    if (scenario.kind === "workspace") {
      const workspace = this.requireWorkspace(scenario);
      const baseImage = workspace.config.baseImage || "dev-base";
      return `${config.kubernetes.registryUrl}/${baseImage}:latest`;
    }
    return `${config.kubernetes.registryUrl}/dev-base:latest`;
  }

  private snapshotNameForKey(key: string): string {
    return `prebuild-${this.normalizeKey(key)}`;
  }

  private resourceNameForKey(key: string): string {
    return `prebuild-${this.normalizeKey(key)}`;
  }

  private normalizeKey(key: string): string {
    const normalized = key
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return normalized || "system";
  }

  /** Used in mock mode only — captures hashes from remote via git ls-remote */
  private async captureCommitHashes(
    workspace: Workspace,
  ): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    if (!workspace.config.repos.length) return hashes;

    for (const repo of workspace.config.repos) {
      const gitUrl = this.buildGitUrl(repo);
      const token = this.getGitToken();
      const authUrl = token
        ? gitUrl.replace(GIT_TOKEN_PLACEHOLDER, token)
        : gitUrl;

      const result = await $`git ls-remote ${authUrl} refs/heads/${repo.branch}`
        .quiet()
        .nothrow();
      if (result.exitCode !== 0) continue;

      const output = result.stdout.toString().trim();
      if (!output) continue;

      const hash = output.split("\t")[0];
      if (hash) hashes[repo.clonePath] = hash;
    }

    return hashes;
  }

  private buildGitUrl(repo: RepoConfig): string {
    const token = this.deps.userService.resolveGitHubToken();
    if (token && repo.url.includes("github.com")) {
      return repo.url.replace("https://", `https://x-access-token:${token}@`);
    }
    return repo.url;
  }

  private getGitToken(): string | undefined {
    return this.deps.userService.resolveGitHubToken();
  }

  private updatePrebuildStatus(
    workspaceId: string,
    workspace: Workspace,
    status: PrebuildStatus,
    latestId?: string,
    commitHashes?: Record<string, string>,
    errorMessage?: string,
  ): void {
    const now = new Date().toISOString();
    const prebuild: WorkspaceConfig["prebuild"] = {
      status,
      latestId: latestId ?? workspace.config.prebuild?.latestId,
      builtAt: status === "ready" ? now : undefined,
      commitHashes: status === "ready" ? commitHashes : undefined,
      lastCheckedAt: status === "ready" ? now : undefined,
      stale: status === "ready" ? false : undefined,
      errorMessage: status === "failed" ? errorMessage : undefined,
    };

    this.deps.workspaceService.update(workspaceId, {
      config: { ...workspace.config, prebuild },
    });

    eventBus.emit({
      type: "prebuild.updated",
      properties: { workspaceId, status },
    });
  }
}
