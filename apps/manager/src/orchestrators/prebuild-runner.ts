import { VM } from "@frak/atelier-shared/constants";
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
  Workspace,
  WorkspaceConfig,
} from "../schemas/index.ts";
import { config, isMock } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { PhaseTimer } from "../shared/lib/phase-timer.ts";
import { warmupOpencode } from "./opencode-warmup.ts";
import { getRemoteCommitHash } from "./ports/git-remote.ts";
import { GuestOps } from "./ports/guest-ops.ts";

const log = createChildLogger("prebuild-runner");

const POLL_INTERVAL_MS = 2000;
const AGENT_TIMEOUT_MS = 60_000;
const SNAPSHOT_TIMEOUT_MS = 300_000;
const SNAPSHOT_DELETE_TIMEOUT_MS = 60_000;
const INIT_COMMAND_TIMEOUT_MS = 300_000;
const MAX_PREBUILD_RETRIES = 5;
const RETRY_DELAY_MS = 5_000;
const PVC_DELETE_TIMEOUT_MS = 60_000;
const COMMIT_HASH_CAPTURE_ATTEMPTS = 5;
const COMMIT_HASH_CAPTURE_RETRY_DELAY_MS = 1_000;

// Deterministic failures (a bad init command, a missing snapshot class) that a
// retry can only reproduce. The runner fails fast on these instead of burning
// the full retry budget — up to 5 × 5-min init-command timeouts otherwise.
export class PrebuildPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrebuildPermanentError";
  }
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
        await this.runWorkspacePrebuild(workspaceId);
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof PrebuildPermanentError) break;
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

  /**
   * Promote a running sandbox's current filesystem into the workspace prebuild.
   *
   * Unlike `run()` (which provisions a fresh pod and replays init commands),
   * promote snapshots the *live* sandbox PVC as-is, so manual changes made in
   * the sandbox are captured. Commit hashes are read from the pod before it is
   * stopped — a "ready" prebuild with no hashes is treated as stale, so the
   * next `PrebuildChecker` tick would otherwise silently overwrite this
   * promotion with a clean rebuild.
   *
   * The caller injects sandbox stop/start: pod lifecycle (and the sandbox
   * status row) is owned by `SandboxLifecycle`, not the runner. The snapshot
   * is taken while the pod is stopped so the source PVC is unmounted.
   */
  async promote(
    workspaceId: string,
    sandboxId: string,
    lifecycle: { stop: () => Promise<void>; start: () => Promise<void> },
  ): Promise<{ snapshotName: string }> {
    const workspace = this.deps.workspaceService.getById(workspaceId);
    if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);

    const snapshotName = this.snapshotNameForKey(workspaceId);

    if (isMock()) {
      const commitHashes = await this.captureCommitHashes(workspace);
      this.updatePrebuildStatus(
        workspaceId,
        workspace,
        "ready",
        snapshotName,
        commitHashes,
      );
      return { snapshotName };
    }

    await this.verifySnapshotCapability();

    const namespace = config.kubernetes.namespace;
    const podName = `sandbox-${sandboxId}`;
    const pvcName = `sandbox-${sandboxId}`;
    const labelValue = this.normalizeKey(workspaceId);

    // Capture HEADs while the pod is still running — a stopped pod has no agent.
    const commitHashes = await this.captureCommitHashesFromPod(
      sandboxId,
      workspace,
    );

    // Flush page cache so the snapshot is filesystem-consistent.
    await this.deps.agentClient
      .exec(sandboxId, "sync", { timeout: 10_000 })
      .catch(() => {});

    // Stop the pod so the PVC is unmounted before we snapshot it.
    await lifecycle.stop();
    await this.waitForPodTermination(podName, namespace);

    await this.createWorkspaceSnapshot(
      snapshotName,
      pvcName,
      namespace,
      labelValue,
    );

    await lifecycle.start();

    this.updatePrebuildStatus(
      workspaceId,
      workspace,
      "ready",
      snapshotName,
      commitHashes,
    );

    log.info(
      { workspaceId, sandboxId, snapshotName },
      "Sandbox promoted to prebuild",
    );
    return { snapshotName };
  }

  // ---------------------------------------------------------------------------
  // Core prebuild runner
  // ---------------------------------------------------------------------------

  private async runWorkspacePrebuild(workspaceId: string): Promise<void> {
    const key = workspaceId;
    if (this.activeBuilds.has(key)) {
      throw new Error(
        `Workspace '${workspaceId}' already has a prebuild in progress`,
      );
    }

    const workspace = this.requireWorkspace(workspaceId);
    if (workspace.config.prebuild?.status === "building") {
      throw new Error(
        `Workspace '${workspaceId}' already has a prebuild in progress`,
      );
    }
    this.setStatus(workspaceId, "building");

    const namespace = config.kubernetes.namespace;
    const resourceName = this.resourceNameForKey(key);
    const pvcName = resourceName;
    const podName = resourceName;
    const configMapName = `${resourceName}-config`;
    this.activeBuilds.set(key, { podName, pvcName });
    const labelValue = this.normalizeKey(key);

    try {
      if (isMock()) {
        const commitHashes = await this.captureCommitHashes(workspace);
        const snapshotName = this.snapshotNameForKey(key);
        this.setStatus(workspaceId, "ready", snapshotName, commitHashes);
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
        const image = this.resolveBaseImage(workspaceId);
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

        // Use workspace resource config, with a generous floor for prebuild.
        const memoryMb = Math.max(workspace.config.memoryMb ?? 4096, 4096);
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
        this.runPrebuildSteps(sandboxId, workspaceId, timer),
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

      // Step 6: Snapshot the temp PVC, wait until ready to clone.
      const snapshotName = this.snapshotNameForKey(key);
      await timer.step("create_snapshot", () =>
        this.createWorkspaceSnapshot(
          snapshotName,
          pvcName,
          namespace,
          labelValue,
        ),
      );

      log.info({ key, snapshotName }, "Prebuild snapshot ready");

      // Step 8: Update status
      this.setStatus(workspaceId, "ready", snapshotName, commitHashes);
      timer.end();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(workspaceId, "failed", undefined, undefined, message);
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
    workspaceId: string,
    timer: PhaseTimer,
  ): Promise<Record<string, string>> {
    const agent = this.deps.agentClient;
    const githubToken = this.deps.userService.resolveGitHubToken();
    const workspace = this.requireWorkspace(workspaceId);
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
      await this.pushWorkspaceConfigs(sandboxId, workspaceId);
    });

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
          throw new PrebuildPermanentError(
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

    // OpenCode warmup
    const bootstrapDirs = this.resolveWarmupDirs(workspaceId);
    await timer.step("opencode_warmup", () =>
      warmupOpencode(
        {
          agentClient: this.deps.agentClient,
          kubeClient: this.deps.kubeClient,
        },
        sandboxId,
        bootstrapDirs,
      ),
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
    workspaceId: string,
  ): Promise<void> {
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

  private resolveWarmupDirs(workspaceId: string): string[] {
    const workspace = this.deps.workspaceService.getById(workspaceId);
    const repos = workspace?.config.repos ?? [];
    if (repos.length === 0) {
      return [VM.WORKSPACE_DIR];
    }
    return repos.map((repo) => GuestOps.resolveClonePath(repo));
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
      throw new PrebuildPermanentError(
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
      throw new PrebuildPermanentError(
        configuredClass
          ? `VolumeSnapshotClass '${configuredClass}' not found. ` +
              "Prebuilds cannot proceed without a valid snapshot class."
          : "No VolumeSnapshotClass found in the cluster. " +
              "Create one for your CSI driver to enable prebuilds.",
      );
    }
  }

  private requireWorkspace(workspaceId: string): Workspace {
    const workspace = this.deps.workspaceService.getById(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace '${workspaceId}' not found`);
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

  // Delete-and-wait (not a blind sleep) before recreate: a still-terminating
  // VolumeSnapshot of the same name 409s the create.
  private async createWorkspaceSnapshot(
    snapshotName: string,
    pvcName: string,
    namespace: string,
    labelValue: string,
  ): Promise<void> {
    if (
      await this.deps.kubeClient.resourceExists(
        "VolumeSnapshot",
        snapshotName,
        namespace,
      )
    ) {
      await this.deps.kubeClient
        .deleteResource("VolumeSnapshot", snapshotName, namespace)
        .catch(() => {});
      await this.deps.kubeClient.waitForResourceDeleted(
        "VolumeSnapshot",
        snapshotName,
        { namespace, timeout: SNAPSHOT_DELETE_TIMEOUT_MS },
      );
    }

    log.info({ snapshotName, pvcName }, "Creating VolumeSnapshot");
    await this.deps.kubeClient.createResource(
      buildVolumeSnapshot({
        name: snapshotName,
        namespace,
        pvcName,
        labels: { "atelier.dev/prebuild": labelValue },
      }),
      namespace,
    );

    const ready = await this.deps.kubeClient.waitForVolumeSnapshotReady(
      snapshotName,
      { timeout: SNAPSHOT_TIMEOUT_MS, namespace },
    );
    if (!ready) {
      throw new Error(`VolumeSnapshot ${snapshotName} did not become ready`);
    }
  }

  private resolveBaseImage(workspaceId: string): string {
    const baseImage =
      this.requireWorkspace(workspaceId).config.baseImage || "dev-base";
    return `${config.kubernetes.registryUrl}/${baseImage}:latest`;
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

    const githubToken = this.deps.userService.resolveGitHubToken();
    for (const repo of workspace.config.repos) {
      const hash = await getRemoteCommitHash(repo, githubToken);
      if (hash) hashes[repo.clonePath] = hash;
    }

    return hashes;
  }

  // Re-fetch the workspace before each transition (it may have been deleted
  // mid-build) and no-op if it's gone.
  private setStatus(
    workspaceId: string,
    status: PrebuildStatus,
    latestId?: string,
    commitHashes?: Record<string, string>,
    errorMessage?: string,
  ): void {
    const workspace = this.deps.workspaceService.getById(workspaceId);
    if (!workspace) return;
    this.updatePrebuildStatus(
      workspaceId,
      workspace,
      status,
      latestId,
      commitHashes,
      errorMessage,
    );
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
