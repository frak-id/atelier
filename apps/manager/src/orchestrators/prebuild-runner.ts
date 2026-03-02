import { VM } from "@frak/atelier-shared/constants";
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
import type { GitSourceService } from "../modules/git-source/index.ts";
import type { SystemAiService } from "../modules/system-sandbox/index.ts";
import { SYSTEM_WORKSPACE_ID } from "../modules/system-sandbox/index.ts";
import type { WorkspaceService } from "../modules/workspace/index.ts";
import type {
  GitHubSourceConfig,
  PrebuildStatus,
  RepoConfig,
  Workspace,
  WorkspaceConfig,
} from "../schemas/index.ts";
import { config, isMock } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { GuestOps } from "./ports/guest-ops.ts";

const log = createChildLogger("prebuild-runner");

const POLL_INTERVAL_MS = 2000;
const POD_TIMEOUT_MS = 120_000;
const AGENT_TIMEOUT_MS = 60_000;
const SNAPSHOT_TIMEOUT_MS = 300_000;
const OPENCODE_WARMUP_TIMEOUT = 10;
const GIT_TOKEN_PLACEHOLDER = "$" + "{GIT_TOKEN}";

export type PrebuildScenario =
  | {
      kind: "workspace";
      workspaceId: string;
      getWorkspace: () => Workspace | undefined;
      updateStatus: (
        status: PrebuildStatus,
        latestId?: string,
        commitHashes?: Record<string, string>,
      ) => void;
      aiService?: SystemAiService;
    }
  | { kind: "system" };

export interface PrebuildRunnerDependencies {
  workspaceService: WorkspaceService;
  gitSourceService: GitSourceService;
  kubeClient: KubeClient;
  agentClient: AgentClient;
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

    await this.runScenario({
      kind: "workspace",
      workspaceId,
      getWorkspace: () => this.deps.workspaceService.getById(workspaceId),
      updateStatus: (status, latestId, commitHashes) => {
        const current = this.deps.workspaceService.getById(workspaceId);
        if (!current) return;
        this.updatePrebuildStatus(
          workspaceId,
          current,
          status,
          latestId,
          commitHashes,
        );
      },
      aiService: this.deps.aiService,
    });
  }

  async runSystem(): Promise<void> {
    await this.runScenario({ kind: "system" });
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
    await this.cleanupBuildResources(SYSTEM_WORKSPACE_ID);
  }

  async delete(workspaceId?: string): Promise<void> {
    if (!workspaceId) throw new Error("Workspace ID is required");

    const workspace = this.deps.workspaceService.getById(workspaceId);
    if (!workspace) throw new Error(`Workspace '${workspaceId}' not found`);

    await this.cleanupStorage(workspaceId);
    this.updatePrebuildStatus(workspaceId, workspace, "none");
  }

  async deleteSystem(): Promise<void> {
    await this.cleanupStorage(SYSTEM_WORKSPACE_ID);
  }

  async ensureSystemPrebuild(): Promise<void> {
    const exists = await this.hasPrebuild(SYSTEM_WORKSPACE_ID);
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
    const exists = await this.hasPrebuild(SYSTEM_WORKSPACE_ID);
    if (!exists) return null;
    return {
      latestId: this.snapshotNameForKey(SYSTEM_WORKSPACE_ID),
      builtAt: new Date().toISOString(),
    };
  }

  isBuilding(key?: string): boolean {
    return key ? this.activeBuilds.has(key) : false;
  }

  isSystemBuilding(): boolean {
    return this.activeBuilds.has(SYSTEM_WORKSPACE_ID);
  }

  async getSystemStatus(): Promise<{
    hasPrebuild: boolean;
    building: boolean;
  }> {
    return {
      hasPrebuild: await this.hasPrebuild(SYSTEM_WORKSPACE_ID),
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
        `/apis/snapshot.storage.k8s.io/v1/namespaces/${config.kubernetes.systemNamespace}/volumesnapshots/${snapshotName}`,
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
        config.kubernetes.systemNamespace,
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
      scenario.kind === "workspace"
        ? scenario.workspaceId
        : SYSTEM_WORKSPACE_ID;
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

    const namespace = config.kubernetes.systemNamespace;
    const resourceName = this.resourceNameForKey(key);
    const pvcName = resourceName;
    const podName = resourceName;
    const configMapName = `${resourceName}-config`;
    this.activeBuilds.set(key, { podName, pvcName });

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

      // Step 1: Create temp PVC
      const volumeSize = config.kubernetes.defaultVolumeSize;
      log.info({ key, pvcName, volumeSize }, "Creating prebuild PVC");

      await this.deps.kubeClient.createResource(
        buildPvc({
          name: pvcName,
          namespace,
          size: volumeSize,
          labels: { "atelier.dev/prebuild": key },
        }),
        namespace,
      );

      const pvcBound = await this.deps.kubeClient.waitForPvcBound(pvcName, {
        timeout: POD_TIMEOUT_MS,
        namespace,
      });
      if (!pvcBound) {
        throw new Error(`Prebuild PVC ${pvcName} did not become bound`);
      }

      // Step 2: Spawn temp pod with base image + PVC at /home/dev
      const image = this.resolveBaseImage(scenario);
      const sandboxId = resourceName;
      log.info({ key, podName, image }, "Spawning prebuild pod");

      await this.deps.kubeClient.createResource(
        buildConfigMap(
          configMapName,
          { "config.json": JSON.stringify({ prebuild: true }) },
          namespace,
          { "atelier.dev/prebuild": key },
        ),
        namespace,
      );

      await this.deps.kubeClient.createResource(
        buildSandboxPod({
          sandboxId,
          image,
          opencodePassword: "prebuild",
          pvcName,
          configMapName,
          namespace,
          requests: { cpu: "500m", memory: "2Gi" },
          limits: { cpu: "2000m", memory: "4Gi" },
        }),
        namespace,
      );

      // Step 3: Wait for pod + agent ready
      const podReady = await this.deps.kubeClient.waitForPodReady(
        `sandbox-${sandboxId}`,
        { timeout: POD_TIMEOUT_MS, namespace },
      );
      if (!podReady) {
        throw new Error(`Prebuild pod ${podName} did not become ready`);
      }

      const agentReady = await this.deps.agentClient.waitForAgent(sandboxId, {
        timeout: AGENT_TIMEOUT_MS,
      });
      if (!agentReady) {
        throw new Error(`Agent in prebuild pod ${podName} did not start`);
      }

      // Step 4: Run prebuild steps via agent
      await this.runPrebuildSteps(sandboxId, scenario);

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
          labels: { "atelier.dev/prebuild": key },
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
        const workspace = this.requireWorkspace(scenario);
        const commitHashes = await this.captureCommitHashes(workspace);
        scenario.updateStatus("ready", snapshotName, commitHashes);

        scenario.aiService?.generateDescriptionInBackground(
          workspace,
          "updated",
          (description) => {
            this.deps.workspaceService.update(scenario.workspaceId, {
              config: { description },
            });
          },
        );
      }
    } catch (error) {
      if (scenario.kind === "workspace") {
        const workspace = scenario.getWorkspace();
        if (workspace) scenario.updateStatus("failed");
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
  ): Promise<void> {
    const agent = this.deps.agentClient;

    if (scenario.kind === "workspace") {
      const workspace = this.requireWorkspace(scenario);

      // Clone repositories
      if (workspace.config.repos?.length) {
        for (const repo of workspace.config.repos) {
          await GuestOps.cloneRepository(
            agent,
            sandboxId,
            repo,
            this.deps.gitSourceService,
          );
        }

        // Sanitize git URLs (remove tokens from remote)
        await GuestOps.sanitizeGitRemoteUrls(
          agent,
          sandboxId,
          workspace.config.repos,
        );
      }

      // Run init commands
      for (const command of workspace.config.initCommands) {
        log.info({ sandboxId, command }, "Running init command");
        const result = await agent.exec(sandboxId, command, {
          timeout: 300_000,
          user: "dev",
          workdir: VM.WORKSPACE_DIR,
        });
        if (result.exitCode !== 0) {
          log.warn(
            { sandboxId, command, stderr: result.stderr },
            "Init command failed (non-blocking)",
          );
        }
      }
    }

    // OpenCode warmup (both workspace and system)
    log.info({ sandboxId }, "Running OpenCode warmup");
    await agent.exec(
      sandboxId,
      `timeout ${OPENCODE_WARMUP_TIMEOUT} opencode serve --hostname 127.0.0.1 --port 4200 2>/dev/null || true`,
      { timeout: (OPENCODE_WARMUP_TIMEOUT + 5) * 1000, user: "dev" },
    );
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

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

    const namespace = config.kubernetes.systemNamespace;
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

  private async captureCommitHashes(
    workspace: Workspace,
  ): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};
    if (!workspace.config.repos.length) return hashes;

    for (const repo of workspace.config.repos) {
      const gitUrl = await this.buildGitUrl(repo);
      const token = this.getGitToken(repo);
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

  private async buildGitUrl(repo: RepoConfig): Promise<string> {
    if ("url" in repo) return repo.url;

    const source = this.deps.gitSourceService.getById(repo.sourceId);
    if (!source) {
      log.warn({ sourceId: repo.sourceId }, "Git source not found");
      return `https://github.com/${repo.repo}.git`;
    }

    if (source.type === "github") {
      const ghConfig = source.config as GitHubSourceConfig;
      if (ghConfig.accessToken) {
        return `https://x-access-token:${GIT_TOKEN_PLACEHOLDER}@github.com/${repo.repo}.git`;
      }
    }

    return `https://github.com/${repo.repo}.git`;
  }

  private getGitToken(repo: RepoConfig): string | undefined {
    if ("url" in repo) return undefined;
    const source = this.deps.gitSourceService.getById(repo.sourceId);
    if (!source || source.type !== "github") return undefined;
    const ghConfig = source.config as GitHubSourceConfig;
    return ghConfig.accessToken || undefined;
  }

  private updatePrebuildStatus(
    workspaceId: string,
    workspace: Workspace,
    status: PrebuildStatus,
    latestId?: string,
    commitHashes?: Record<string, string>,
  ): void {
    const now = new Date().toISOString();
    const prebuild: WorkspaceConfig["prebuild"] = {
      status,
      latestId: latestId ?? workspace.config.prebuild?.latestId,
      builtAt: status === "ready" ? now : undefined,
      commitHashes: status === "ready" ? commitHashes : undefined,
      lastCheckedAt: status === "ready" ? now : undefined,
      stale: status === "ready" ? false : undefined,
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
