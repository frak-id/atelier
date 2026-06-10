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
import {
  ImageNotAvailableError,
  ImageRegistryService,
  RegistryService,
} from "../infrastructure/registry/index.ts";
import type { InternalService } from "../modules/internal/index.ts";
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
import {
  buildOpenCodeAuthHeaders,
  createTimeoutFetch,
  OPENCODE_REQUEST_TIMEOUT_MS,
} from "../shared/lib/opencode-auth.ts";
import { PhaseTimer } from "../shared/lib/phase-timer.ts";
import { GuestOps } from "./ports/guest-ops.ts";

const log = createChildLogger("prebuild-runner");

const POLL_INTERVAL_MS = 2000;
// const POD_TIMEOUT_MS = 120_000;
const AGENT_TIMEOUT_MS = 60_000;
const SNAPSHOT_TIMEOUT_MS = 300_000;
const INIT_COMMAND_TIMEOUT_MS = 300_000;
const OPENCODE_HEALTH_TIMEOUT_MS = 120_000;
const OPENCODE_WARMUP_BOOTSTRAP_TIMEOUT_MS = 120_000;
const OPENCODE_WARMUP_PORT = 4200;
const GIT_TOKEN_PLACEHOLDER = "$" + "{GIT_TOKEN}";
const MAX_PREBUILD_RETRIES = 5;
const RETRY_DELAY_MS = 5_000;
const PVC_DELETE_TIMEOUT_MS = 60_000;
const COMMIT_HASH_CAPTURE_ATTEMPTS = 5;
const COMMIT_HASH_CAPTURE_RETRY_DELAY_MS = 1_000;

export interface PrebuildScenario {
  kind: "workspace";
  workspaceId: string;
  getWorkspace: () => Workspace | undefined;
  updateStatus: (
    status: PrebuildStatus,
    latestId?: string,
    commitHashes?: Record<string, string>,
    errorMessage?: string,
  ) => void;
}

export interface PrebuildRunnerDependencies {
  workspaceService: WorkspaceService;
  userService: UserService;
  kubeClient: KubeClient;
  agentClient: AgentClient;
  internalService: InternalService;
}

type ActiveBuild = { podName: string; pvcName: string };

export class PrebuildRunner {
  protected readonly activeBuilds = new Map<string, ActiveBuild>();

  constructor(protected readonly deps: PrebuildRunnerDependencies) {}

  async run(workspaceId?: string): Promise<void> {
    if (!workspaceId) throw new Error("Workspace ID is required");

    const workspace = this.deps.workspaceService.getById(workspaceId);
    if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);

    // A missing base image is not transient — fail once with a clear status
    // instead of burning the retry budget on ImagePullBackOff pods.
    const baseImage = workspace.config.baseImage || "dev-base";
    try {
      await ImageRegistryService.assertImageAvailable(baseImage);
    } catch (error) {
      if (error instanceof ImageNotAvailableError) {
        this.updatePrebuildStatus(
          workspaceId,
          workspace,
          "failed",
          undefined,
          undefined,
          error.message,
        );
      }
      throw error;
    }

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

  runInBackground(workspaceId?: string): void {
    setImmediate(() => {
      this.run(workspaceId).catch((error) => {
        log.error({ workspaceId, error }, "Background prebuild failed");
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

  async delete(workspaceId?: string): Promise<void> {
    if (!workspaceId) throw new Error("Workspace ID is required");

    const workspace = this.deps.workspaceService.getById(workspaceId);
    if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);

    await this.cleanupStorage(workspaceId);
    this.updatePrebuildStatus(workspaceId, workspace, "none");
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
    const key = scenario.workspaceId;
    if (this.activeBuilds.has(key)) {
      throw new Error(
        `Workspace '${scenario.workspaceId}' already has a prebuild in progress`,
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

      const timer = new PhaseTimer(log, {
        metric: "prebuild_create",
        workspaceId: key,
      });
      const sandboxId = resourceName;

      // Pre-flight: verify snapshot capability
      await timer.step("verify_capability", () =>
        this.verifySnapshotCapability(),
      );

      // Step 1: Create temp PVC
      await timer.step("create_pvc", async () => {
        const volumeSize = config.kubernetes.defaultVolumeSize;
        log.info({ key, pvcName, volumeSize }, "Creating prebuild PVC");

        await this.ensurePvcDeleted(pvcName, namespace, key);

        await this.deps.kubeClient.createResource(
          buildPvc({
            name: pvcName,
            namespace,
            size: volumeSize,
            labels: { "atelier.dev/prebuild": labelValue },
          }),
          namespace,
        );
      });

      // Note: no waitForPvcBound — local-path uses WaitForFirstConsumer,
      // so the PVC binds only when a pod referencing it is scheduled.
      // Step 2: Spawn temp pod with base image + PVC at /home/dev
      await timer.step("create_pod", async () => {
        const image = this.resolveBaseImage(scenario);
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
      });

      // Step 3: Wait for pod + agent ready
      // Single wait: agent health check implies pod is ready and has an IP
      await timer.step("wait_agent", async () => {
        const { ready: agentReady } = await this.deps.agentClient.waitForAgent(
          sandboxId,
          {
            timeout: AGENT_TIMEOUT_MS,
          },
        );
        if (!agentReady) {
          throw new Error(`Agent in prebuild pod ${podName} did not start`);
        }
      });

      // Step 4: Run prebuild steps via agent
      const commitHashes = await timer.step("prebuild_steps", () =>
        this.runPrebuildSteps(sandboxId, scenario, timer),
      );

      // Flush writes to PVC before snapshot
      await timer.step("flush_sync", async () => {
        log.info({ key }, "Flushing writes before snapshot");
        await this.deps.agentClient.exec(sandboxId, "sync", {
          timeout: 10_000,
        });
      });

      // Step 5: Stop the pod (to flush writes)
      await timer.step("stop_pod", async () => {
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
      });

      // Step 6: Create VolumeSnapshot from temp PVC
      const snapshotName = this.snapshotNameForKey(key);
      await timer.step("create_snapshot", async () => {
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
      });

      // Step 7: Wait for snapshot ready
      await timer.step("wait_snapshot", async () => {
        const snapReady = await this.deps.kubeClient.waitForVolumeSnapshotReady(
          snapshotName,
          { timeout: SNAPSHOT_TIMEOUT_MS, namespace },
        );
        if (!snapReady) {
          throw new Error(
            `VolumeSnapshot ${snapshotName} did not become ready`,
          );
        }
      });

      log.info({ key, snapshotName }, "Prebuild snapshot ready");

      // Step 8: Update status
      scenario.updateStatus("ready", snapshotName, commitHashes);
      timer.end();
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
    timer: PhaseTimer,
  ): Promise<Record<string, string>> {
    const agent = this.deps.agentClient;
    const githubToken = this.deps.userService.resolveGitHubToken();
    let commitHashes: Record<string, string> = {};

    await timer.step("push_configs", async () => {
      // Point npm/bun/yarn at the configured npm registry before any install
      // runs. Without this, both `initCommands` and OpenCode's plugin install
      // during warmup go to the public npm registry — which is the main reason
      // `oh-my-openagent@x.y.z` takes ~13s instead of <1s on a warm cache.
      await this.pushRegistryConfig(sandboxId);

      // Push merged workspace/system config files (opencode.json with plugin
      // definitions, MCP server, CLIProxy provider, etc.) into the prebuild
      // pod. Without this, OpenCode warmup boots blind: it never sees external
      // plugins like `oh-my-openagent`, never downloads them into
      // ~/.cache/opencode/packages, and the snapshot ships cold — every
      // runtime sandbox then pays the full plugin install cost on first use.
      await this.pushWorkspaceConfigs(sandboxId, scenario);
    });

    if (scenario.kind === "workspace") {
      const workspace = this.requireWorkspace(scenario);

      // Clone repositories
      if (workspace.config.repos?.length) {
        const repos = workspace.config.repos;
        await timer.step("clone_repos", async () => {
          for (const repo of repos) {
            await GuestOps.cloneRepository(agent, sandboxId, repo, githubToken);
          }

          // Sanitize git URLs (remove tokens from remote)
          await GuestOps.sanitizeGitRemoteUrls(agent, sandboxId, repos);
        });

        // Capture commit hashes from inside the pod
        commitHashes = await this.captureCommitHashesFromPod(
          sandboxId,
          workspace,
        );

        // A "ready" prebuild must carry a hash for every repo: the staleness
        // checker treats any missing hash as stale and rebuilds on the next
        // cron tick, so a snapshot with gaps loops forever. Fail the attempt
        // (it retries) instead of shipping a perpetually-stale snapshot.
        if (Object.keys(commitHashes).length < repos.length) {
          throw new Error(
            `Captured ${Object.keys(commitHashes).length}/${repos.length} repo commit hashes; failing prebuild to avoid a perpetually-stale snapshot`,
          );
        }
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
      await timer.step("init_commands", async () => {
        for (const command of workspace.config.initCommands) {
          log.info({ sandboxId, command }, "Running init command");
          const result = await agent.exec(sandboxId, command, {
            timeout: INIT_COMMAND_TIMEOUT_MS,
            user: "dev",
            workdir: VM.WORKSPACE_DIR,
          });
          if (result.exitCode !== 0) {
            throw new Error(
              `Init command failed: ${command}\n${result.stderr}`,
            );
          }
        }
      });

      // Fix ownership after init commands
      log.info({ sandboxId }, "Fixing workspace ownership");
      await agent.exec(sandboxId, `chown -R dev:dev ${VM.WORKSPACE_DIR}`, {
        timeout: INIT_COMMAND_TIMEOUT_MS,
      });
    }

    // OpenCode warmup (both workspace and system)
    const bootstrapDirs = this.resolveWarmupDirs(scenario);
    await timer.step("opencode_warmup", () =>
      this.warmupOpencode(sandboxId, bootstrapDirs),
    );

    return commitHashes;
  }

  private async pushRegistryConfig(sandboxId: string): Promise<void> {
    const files = RegistryService.buildRegistryConfigFiles();
    if (!files) return;

    try {
      await this.deps.agentClient.writeFiles(sandboxId, files);
      log.info(
        { sandboxId, fileCount: files.length },
        "Pushed npm registry config to prebuild pod",
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
    const workspaceId = scenario.workspaceId;
    try {
      const result = await this.deps.internalService.syncConfigsToSandbox(
        sandboxId,
        { workspaceId },
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
    const workspace = scenario.getWorkspace();
    const repos = workspace?.config.repos ?? [];
    if (repos.length === 0) {
      return [VM.WORKSPACE_DIR];
    }
    return repos.map((repo) => GuestOps.resolveClonePath(repo));
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

    // The readiness probe must fail fast — a wedged /health should not burn the
    // warmup budget — but the bootstrap calls below legitimately run for tens of
    // seconds (DB migration, plugin npm install, ripgrep download). One short
    // timeout would abort them, so use two clients with two request budgets.
    const probeClient = createOpencodeClient({
      baseUrl: `http://${podIp}:${port}`,
      headers: buildOpenCodeAuthHeaders("prebuild"),
      fetch: createTimeoutFetch(OPENCODE_REQUEST_TIMEOUT_MS),
    });

    const healthy = await this.waitForWarmupHealth(probeClient, sandboxId);
    if (!healthy) {
      await this.killWarmupOpencode(sandboxId);
      return;
    }

    const bootstrapClient = createOpencodeClient({
      baseUrl: `http://${podIp}:${port}`,
      headers: buildOpenCodeAuthHeaders("prebuild"),
      fetch: createTimeoutFetch(OPENCODE_WARMUP_BOOTSTRAP_TIMEOUT_MS),
    });

    // Trigger InstanceBootstrap for each workspace dir. This is what installs
    // plugins, downloads ripgrep, applies migrations, and primes the project
    // .opencode/ directory — the work we want baked into the snapshot.
    for (const directory of bootstrapDirs) {
      const ok = await this.bootstrapWarmupDirectory(
        bootstrapClient,
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
      const fullPath = GuestOps.resolveClonePath(repo);
      const hash = await this.captureRepoHeadHash(
        sandboxId,
        fullPath,
        workspace.id,
      );
      if (hash) hashes[repo.clonePath] = hash;
    }

    return hashes;
  }

  // `git rev-parse HEAD` here intermittently returns a non-zero exit with empty
  // stderr: the guest process is killed by a signal early in the pod's life, not
  // a git error. It's transient, so retry before giving up — a missed hash
  // poisons staleness detection and triggers an endless rebuild loop.
  private async captureRepoHeadHash(
    sandboxId: string,
    fullPath: string,
    workspaceId: string,
  ): Promise<string | null> {
    for (let attempt = 1; attempt <= COMMIT_HASH_CAPTURE_ATTEMPTS; attempt++) {
      const result = await this.deps.agentClient.exec(
        sandboxId,
        `git -C '${fullPath}' rev-parse HEAD`,
        { timeout: 10_000, user: "dev" },
      );
      const hash = result.stdout.trim();
      if (result.exitCode === 0 && hash) {
        log.debug(
          { workspaceId, clonePath: fullPath, hash },
          "Captured commit hash",
        );
        return hash;
      }

      if (attempt < COMMIT_HASH_CAPTURE_ATTEMPTS) {
        await Bun.sleep(COMMIT_HASH_CAPTURE_RETRY_DELAY_MS);
        continue;
      }

      log.warn(
        {
          workspaceId,
          clonePath: fullPath,
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
        "Failed to capture commit hash after retries",
      );
    }
    return null;
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

  // A previous failed attempt can leave this PVC still terminating (PVCs carry
  // finalizers + volume-detach latency), so recreating immediately 409s with
  // "object is being deleted". Delete idempotently and wait it fully out.
  private async ensurePvcDeleted(
    pvcName: string,
    namespace: string,
    key: string,
  ): Promise<void> {
    const exists = await this.deps.kubeClient.resourceExists(
      "PersistentVolumeClaim",
      pvcName,
      namespace,
    );
    if (!exists) return;

    log.info(
      { key, pvcName },
      "Prebuild PVC still exists, waiting for deletion before recreate",
    );
    await this.deps.kubeClient
      .deleteResource("PersistentVolumeClaim", pvcName, namespace)
      .catch(() => {});

    const deleted = await this.deps.kubeClient.waitForResourceDeleted(
      "PersistentVolumeClaim",
      pvcName,
      { namespace, timeout: PVC_DELETE_TIMEOUT_MS },
    );
    if (!deleted) {
      throw new Error(
        `Prebuild PVC ${pvcName} did not finish deleting before recreate`,
      );
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
