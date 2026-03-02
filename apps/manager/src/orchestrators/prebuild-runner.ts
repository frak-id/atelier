import { VM } from "@frak/atelier-shared/constants";
import { $ } from "bun";
import { eventBus } from "../infrastructure/events/index.ts";
import {
  buildConfigMap,
  buildKanikoJob,
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

const log = createChildLogger("prebuild-runner");

const KANIKO_NAMESPACE = "atelier-system";
const JOB_POLL_INTERVAL_MS = 2000;
const JOB_TIMEOUT_MS = 600000;
const WORKSPACE_DIR = VM.WORKSPACE_DIR;
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
  aiService?: SystemAiService;
}

type ActiveBuild = { jobName: string; configMapName: string };

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
      await this.deleteKanikoJob(workspaceId);
      return;
    }

    if (workspace.config.prebuild?.status !== "building") {
      throw new Error(`Workspace '${workspaceId}' has no prebuild to cancel`);
    }

    await this.deleteKanikoJob(workspaceId);
    this.updatePrebuildStatus(workspaceId, workspace, "none");
  }

  async cancelSystem(): Promise<void> {
    if (!this.isSystemBuilding()) {
      throw new Error("No system prebuild in progress to cancel");
    }
    await this.deleteKanikoJob(SYSTEM_WORKSPACE_ID);
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
      log.info("System prebuild image exists, skipping");
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
      latestId: this.imageRefForKey(SYSTEM_WORKSPACE_ID),
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

    const imageName = this.imageNameForKey(key);
    try {
      const response = await fetch(
        `http://${config.kubernetes.registryUrl}/v2/${imageName}/tags/list`,
        {
          signal: AbortSignal.timeout(3000),
        },
      );
      if (!response.ok) return false;
      const data = (await response.json()) as { tags?: string[] };
      return (data.tags?.length ?? 0) > 0;
    } catch {
      return false;
    }
  }

  async cleanupStorage(key: string): Promise<void> {
    void key;
  }

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

    const resourceName = this.resourceNameForKey(key);
    this.activeBuilds.set(key, {
      jobName: resourceName,
      configMapName: resourceName,
    });

    try {
      const { dockerfile, buildArgs } = await this.generateDockerfile(scenario);
      const destinationImage = this.imageRefForKey(key);

      if (!isMock()) {
        await this.deps.kubeClient.createResource(
          buildConfigMap(
            resourceName,
            { Dockerfile: dockerfile },
            KANIKO_NAMESPACE,
            { "atelier.dev/sandbox": key },
          ),
          KANIKO_NAMESPACE,
        );

        await this.deps.kubeClient.createResource(
          buildKanikoJob({
            name: resourceName,
            namespace: KANIKO_NAMESPACE,
            configMapName: resourceName,
            destinationImage,
            dockerfilePath: "Dockerfile",
            labels: { "atelier.dev/sandbox": key },
            insecure: true,
            buildArgs,
          }),
          KANIKO_NAMESPACE,
        );

        await this.waitForKanikoJob(resourceName);
      }

      if (scenario.kind === "workspace") {
        const workspace = this.requireWorkspace(scenario);
        const commitHashes = await this.captureCommitHashes(workspace);
        scenario.updateStatus("ready", destinationImage, commitHashes);

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
      await this.cleanupBuildResources(resourceName);
      this.activeBuilds.delete(key);
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

  private async cleanupBuildResources(resourceName: string): Promise<void> {
    if (isMock()) return;

    try {
      await this.deps.kubeClient.deleteResource(
        "jobs",
        resourceName,
        KANIKO_NAMESPACE,
      );
    } catch (error) {
      log.debug({ resourceName, error }, "Failed to cleanup Kaniko job");
    }

    try {
      await this.deps.kubeClient.deleteResource(
        "configmaps",
        resourceName,
        KANIKO_NAMESPACE,
      );
    } catch (error) {
      log.debug({ resourceName, error }, "Failed to cleanup build ConfigMap");
    }
  }

  private async waitForKanikoJob(jobName: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < JOB_TIMEOUT_MS) {
      const status = await this.deps.kubeClient.getJobStatus(
        jobName,
        KANIKO_NAMESPACE,
      );
      if (status === "succeeded") return;
      if (status === "failed") {
        const logs = await this.getKanikoLogs(jobName);
        throw new Error(
          logs
            ? `Kaniko job '${jobName}' failed:\n${logs}`
            : `Kaniko job '${jobName}' failed`,
        );
      }
      await Bun.sleep(JOB_POLL_INTERVAL_MS);
    }

    const logs = await this.getKanikoLogs(jobName);
    throw new Error(
      logs
        ? `Kaniko job '${jobName}' timed out:\n${logs}`
        : `Kaniko job '${jobName}' timed out`,
    );
  }

  private async getKanikoLogs(jobName: string): Promise<string> {
    try {
      const pods = await this.deps.kubeClient.listPods(
        `job-name=${jobName}`,
        KANIKO_NAMESPACE,
      );
      const podName = pods[0]?.metadata?.name;
      if (!podName) return "";
      return await this.deps.kubeClient.getPodLogs(podName, KANIKO_NAMESPACE);
    } catch {
      return "";
    }
  }

  private async deleteKanikoJob(key: string): Promise<void> {
    if (isMock()) return;

    const jobName = this.resourceNameForKey(key);
    try {
      await this.deps.kubeClient.delete(
        `/apis/batch/v1/namespaces/${KANIKO_NAMESPACE}/jobs/${jobName}?propagationPolicy=Background`,
      );
    } catch {}
  }

  private imageNameForKey(key: string): string {
    return key === SYSTEM_WORKSPACE_ID ? "system-sandbox" : `workspace-${key}`;
  }

  private imageRefForKey(key: string): string {
    return `${config.kubernetes.registryUrl}/${this.imageNameForKey(key)}:latest`;
  }

  private resourceNameForKey(key: string): string {
    const normalized = key
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    return `prebuild-${normalized || "system"}`;
  }

  private async generateDockerfile(scenario: PrebuildScenario): Promise<{
    dockerfile: string;
    buildArgs?: Record<string, string>;
  }> {
    if (scenario.kind === "system") {
      return {
        dockerfile: [
          `FROM ${config.kubernetes.registryUrl}/dev-base:latest`,
          "USER dev",
          `WORKDIR ${WORKSPACE_DIR}`,
          "RUN timeout 5 opencode serve --hostname 127.0.0.1 --port 4200 2>/dev/null || true",
        ].join("\n"),
      };
    }

    const workspace = this.requireWorkspace(scenario);
    const lines: string[] = [
      `FROM ${config.kubernetes.registryUrl}/${workspace.config.baseImage}:latest`,
      "USER root",
    ];

    let gitToken: string | undefined;
    for (const repo of workspace.config.repos) {
      const gitUrl = await this.buildGitUrl(repo);
      gitToken ??= this.getGitToken(repo);
      const clonePath = repo.clonePath.startsWith("/")
        ? repo.clonePath
        : `/${repo.clonePath}`;
      lines.push(
        `RUN git clone --depth=1 --branch ${repo.branch} ${gitUrl} ${VM.HOME}${clonePath}`,
      );
    }

    lines.push(`RUN chown -R dev:dev ${WORKSPACE_DIR}`);
    lines.push("USER dev");
    lines.push(`WORKDIR ${WORKSPACE_DIR}`);
    for (const command of workspace.config.initCommands) {
      lines.push(`RUN ${command}`);
    }
    lines.push(
      "RUN timeout 5 opencode serve --hostname 127.0.0.1 --port 4200 2>/dev/null || true",
    );

    if (!gitToken) return { dockerfile: lines.join("\n") };
    lines.splice(1, 0, "ARG GIT_TOKEN");
    return { dockerfile: lines.join("\n"), buildArgs: { GIT_TOKEN: gitToken } };
  }

  private async buildGitUrl(repo: RepoConfig): Promise<string> {
    if ("url" in repo) return repo.url;

    const source = this.deps.gitSourceService.getById(repo.sourceId);
    if (!source) {
      log.warn({ sourceId: repo.sourceId }, "Git source not found");
      return `https://github.com/${repo.repo}.git`;
    }

    if (source.type === "github") {
      const config = source.config as GitHubSourceConfig;
      if (config.accessToken) {
        return `https://x-access-token:${GIT_TOKEN_PLACEHOLDER}@github.com/${repo.repo}.git`;
      }
    }

    return `https://github.com/${repo.repo}.git`;
  }

  private getGitToken(repo: RepoConfig): string | undefined {
    if ("url" in repo) return undefined;
    const source = this.deps.gitSourceService.getById(repo.sourceId);
    if (!source || source.type !== "github") return undefined;
    const config = source.config as GitHubSourceConfig;
    return config.accessToken || undefined;
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
