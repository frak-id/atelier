import { PATHS, VM } from "@frak/atelier-shared/constants";
import type { AgentClient } from "../infrastructure/agent/index.ts";
import { eventBus } from "../infrastructure/events/index.ts";
import { StorageService } from "../infrastructure/storage/index.ts";
import type { InternalService } from "../modules/internal/internal.service.ts";
import type { SandboxRepository } from "../modules/sandbox/index.ts";
import type { SystemAiService } from "../modules/system-sandbox/index.ts";
import { SYSTEM_WORKSPACE_ID } from "../modules/system-sandbox/index.ts";
import type { WorkspaceService } from "../modules/workspace/index.ts";
import type {
  PrebuildStatus,
  Workspace,
  WorkspaceConfig,
} from "../schemas/index.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { ensureDir } from "../shared/lib/shell.ts";
import { waitForOpencode } from "./kernel/boot-waiter.ts";
import type { SandboxDestroyer } from "./sandbox-destroyer.ts";
import type { SandboxSpawner } from "./sandbox-spawner.ts";

const log = createChildLogger("prebuild-runner");

const WORKSPACE_DIR = VM.WORKSPACE_DIR;
const AGENT_READY_TIMEOUT = 60000;
const COMMAND_TIMEOUT = 300000;

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
  | {
      kind: "system";
      getMetadataPath: () => string;
    };

export interface PrebuildRunnerDependencies {
  sandboxSpawner: SandboxSpawner;
  sandboxDestroyer: SandboxDestroyer;
  sandboxService: SandboxRepository;
  agentClient: AgentClient;
  internalService: InternalService;
  workspaceService: WorkspaceService;
  aiService?: SystemAiService;
}

export class PrebuildRunner {
  protected readonly activeBuilds = new Map<
    string,
    { abortController: AbortController; sandboxId?: string }
  >();

  constructor(protected readonly deps: PrebuildRunnerDependencies) {}

  async run(workspaceId?: string): Promise<void> {
    if (!workspaceId) {
      throw new Error("Workspace ID is required");
    }

    const workspace = this.deps.workspaceService.getById(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace '${workspaceId}' not found`);
    }

    const scenario: PrebuildScenario = {
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
    };

    await this.runScenario(scenario);
  }

  async runSystem(): Promise<void> {
    const scenario: PrebuildScenario = {
      kind: "system",
      getMetadataPath: () => this.metadataPath,
    };
    await this.runScenario(scenario);
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
    if (!workspaceId) {
      throw new Error("Workspace ID is required");
    }

    const activeBuild = this.activeBuilds.get(workspaceId);
    if (activeBuild) {
      log.info({ workspaceId }, "Cancelling active prebuild");
      activeBuild.abortController.abort();
      return;
    }

    const workspace = this.deps.workspaceService.getById(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace '${workspaceId}' not found`);
    }

    if (workspace.config.prebuild?.status !== "building") {
      throw new Error(`Workspace '${workspaceId}' has no prebuild to cancel`);
    }

    log.info({ workspaceId }, "Force-resetting stuck prebuild status");
    this.updatePrebuildStatus(workspaceId, workspace, "none");
  }

  async cancelSystem(): Promise<void> {
    const key = SYSTEM_WORKSPACE_ID;
    const activeBuild = this.activeBuilds.get(key);
    if (activeBuild) {
      log.info("Cancelling active system prebuild");
      activeBuild.abortController.abort();
      return;
    }

    if (!this.isSystemBuilding()) {
      throw new Error("No system prebuild in progress to cancel");
    }
  }

  async delete(workspaceId?: string): Promise<void> {
    if (!workspaceId) {
      throw new Error("Workspace ID is required");
    }

    const workspace = this.deps.workspaceService.getById(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace '${workspaceId}' not found`);
    }

    await this.cleanupStorage(workspaceId);
    this.updatePrebuildStatus(workspaceId, workspace, "none");
    log.info({ workspaceId }, "Prebuild deleted");
  }

  async deleteSystem(): Promise<void> {
    await this.cleanupStorage(SYSTEM_WORKSPACE_ID);

    try {
      const file = Bun.file(this.metadataPath);
      if (await file.exists()) {
        const { unlink } = await import("node:fs/promises");
        await unlink(this.metadataPath);
      }
    } catch (error) {
      log.warn({ error }, "Failed to remove system prebuild metadata");
    }

    log.info("System prebuild deleted");
  }

  async ensureSystemPrebuild(): Promise<void> {
    const hasLvm = await StorageService.hasPrebuild(SYSTEM_WORKSPACE_ID);
    if (hasLvm) {
      log.info("System prebuild already exists, skipping");
      return;
    }
    await this.runSystem();
  }

  async readSystemMetadata(): Promise<{
    latestId: string;
    builtAt: string;
  } | null> {
    try {
      const file = Bun.file(this.metadataPath);
      if (!(await file.exists())) return null;
      return (await file.json()) as { latestId: string; builtAt: string };
    } catch {
      return null;
    }
  }

  isBuilding(key?: string): boolean {
    if (!key) return false;
    return this.activeBuilds.has(key);
  }

  isSystemBuilding(): boolean {
    return this.activeBuilds.has(SYSTEM_WORKSPACE_ID);
  }

  getSystemStatus(): { hasPrebuild: boolean; building: boolean } {
    return {
      hasPrebuild: false,
      building: this.isSystemBuilding(),
    };
  }

  async hasPrebuild(key: string): Promise<boolean> {
    return StorageService.hasPrebuild(key);
  }

  async cleanupStorage(key: string): Promise<void> {
    await StorageService.deletePrebuild(key);
  }

  protected throwIfAborted(key: string): void {
    const activeBuild = this.activeBuilds.get(key);
    if (activeBuild?.abortController.signal.aborted) {
      const error = new Error("Prebuild cancelled");
      error.name = "AbortError";
      throw error;
    }
  }

  protected async pushLatestAuthAndConfigs(sandboxId: string): Promise<void> {
    const result = await this.deps.internalService.syncToSandbox(sandboxId);
    log.info(
      {
        sandboxId,
        authSynced: result.auth.synced,
        configsSynced: result.configs.synced,
      },
      "Auth and configs baked into prebuild",
    );
  }

  protected async syncFilesystem(sandboxId: string): Promise<void> {
    await this.deps.agentClient.exec(sandboxId, "sync", { timeout: 5000 });
  }

  protected async warmupOpencode(
    sandboxId: string,
    prebuildKey: string,
    ipAddress: string,
    opencodePassword?: string,
  ): Promise<void> {
    log.info({ prebuildKey }, "Warming up opencode server");

    const port = config.advanced.vm.opencode.port;
    const startResult = await this.deps.agentClient.exec(
      sandboxId,
      `nohup setsid opencode serve --hostname 0.0.0.0 --port ${port} </dev/null >/tmp/opencode-warmup.log 2>&1 &`,
      { timeout: 10000, user: "dev", workdir: WORKSPACE_DIR },
    );

    if (startResult.exitCode !== 0) {
      log.warn(
        { prebuildKey, stderr: startResult.stderr },
        "Failed to start opencode for warmup, continuing anyway",
      );
      return;
    }

    try {
      await waitForOpencode(ipAddress, opencodePassword);
      log.info({ prebuildKey }, "Opencode server is healthy");
    } catch {
      log.warn(
        { prebuildKey },
        "Opencode did not become healthy within timeout, continuing anyway",
      );
    }

    await this.deps.agentClient.exec(sandboxId, "pkill -f 'opencode serve'", {
      timeout: 5000,
    });

    log.info({ prebuildKey }, "Opencode warmup completed");
  }

  private get metadataPath(): string {
    return `${PATHS.SANDBOX_DIR}/system-prebuild.json`;
  }

  private async writeMetadata(latestId: string): Promise<void> {
    await ensureDir(PATHS.SANDBOX_DIR);
    await Bun.write(
      this.metadataPath,
      JSON.stringify(
        {
          latestId,
          builtAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  }

  private async runScenario(scenario: PrebuildScenario): Promise<void> {
    const key =
      scenario.kind === "workspace"
        ? scenario.workspaceId
        : SYSTEM_WORKSPACE_ID;

    if (this.activeBuilds.has(key)) {
      if (scenario.kind === "workspace") {
        throw new Error(
          `Workspace '${scenario.workspaceId}' already has a prebuild in progress`,
        );
      }
      throw new Error("System prebuild already in progress");
    }

    if (scenario.kind === "workspace") {
      const workspace = scenario.getWorkspace();
      if (!workspace) {
        throw new Error(`Workspace '${scenario.workspaceId}' not found`);
      }
      if (workspace.config.prebuild?.status === "building") {
        throw new Error(
          `Workspace '${scenario.workspaceId}' already has a prebuild in progress`,
        );
      }
    }

    const abortController = new AbortController();
    this.activeBuilds.set(key, { abortController });

    if (scenario.kind === "workspace") {
      scenario.updateStatus("building");
      const workspace = scenario.getWorkspace();
      log.info(
        {
          workspaceId: scenario.workspaceId,
          workspaceName: workspace?.name,
        },
        "Starting prebuild",
      );
    } else {
      log.info("Starting system sandbox prebuild");
    }

    if (await StorageService.hasPrebuild(key)) {
      await StorageService.deletePrebuild(key);
      if (scenario.kind === "workspace") {
        log.info(
          { workspaceId: scenario.workspaceId },
          "Deleted existing prebuild",
        );
      } else {
        log.info("Deleted existing system prebuild before regeneration");
      }
    }

    let sandboxId: string | undefined;

    try {
      this.throwIfAborted(key);

      const workspace =
        scenario.kind === "workspace" ? scenario.getWorkspace() : undefined;
      if (scenario.kind === "workspace" && !workspace) {
        throw new Error(`Workspace '${scenario.workspaceId}' not found`);
      }

      const sandbox = await this.deps.sandboxSpawner.spawn(
        scenario.kind === "workspace"
          ? {
              workspaceId: scenario.workspaceId,
              baseImage: workspace?.config.baseImage,
              vcpus: workspace?.config.vcpus,
              memoryMb: workspace?.config.memoryMb,
            }
          : {
              workspaceId: SYSTEM_WORKSPACE_ID,
              system: true,
              vcpus: 1,
              memoryMb: 1024,
            },
      );

      sandboxId = sandbox.id;
      const activeBuild = this.activeBuilds.get(key);
      if (activeBuild) {
        activeBuild.sandboxId = sandboxId;
      }

      log.info({ prebuildSandboxId: sandbox.id }, "Prebuild sandbox spawned");

      this.throwIfAborted(key);

      const agentReady = await this.deps.agentClient.waitForAgent(sandbox.id, {
        timeout: AGENT_READY_TIMEOUT,
      });

      if (!agentReady) {
        throw new Error("Agent failed to become ready");
      }

      let commitHashes: Record<string, string> | undefined;

      if (scenario.kind === "workspace" && workspace) {
        this.throwIfAborted(key);
        await this.runInitCommands(sandbox.id, workspace);

        this.throwIfAborted(key);
        commitHashes = await this.captureCommitHashes(sandbox.id, workspace);
      }

      this.throwIfAborted(key);
      await this.warmupOpencode(
        sandbox.id,
        key,
        sandbox.runtime.ipAddress,
        sandbox.runtime.opencodePassword,
      );

      this.throwIfAborted(key);
      await this.pushLatestAuthAndConfigs(sandbox.id);
      await this.syncFilesystem(sandbox.id);
      await StorageService.createPrebuild(key, sandbox.id);

      if (scenario.kind === "system") {
        await this.writeMetadata(sandbox.id);
      }

      log.info({ sandboxId: sandbox.id }, "Prebuild snapshot created (LVM)");

      await this.deps.sandboxDestroyer.destroy(sandbox.id);

      if (scenario.kind === "workspace" && workspace) {
        scenario.updateStatus("ready", sandbox.id, commitHashes);
        log.info({ workspaceId: scenario.workspaceId }, "Prebuild completed");

        scenario.aiService?.generateDescriptionInBackground(
          workspace,
          "updated",
          (description) => {
            this.deps.workspaceService.update(scenario.workspaceId, {
              config: { description },
            });
          },
        );
      } else {
        log.info("System prebuild completed successfully");
      }
    } catch (error) {
      const isCancelled = error instanceof Error && error.name === "AbortError";
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (scenario.kind === "workspace") {
        if (isCancelled) {
          log.info({ workspaceId: scenario.workspaceId }, "Prebuild cancelled");
        } else {
          log.error(
            { workspaceId: scenario.workspaceId, error: errorMessage },
            "Prebuild failed",
          );
        }
      } else if (isCancelled) {
        log.info("System prebuild cancelled");
      } else {
        log.error({ error: errorMessage }, "System prebuild failed");
      }

      if (sandboxId) {
        await this.deps.sandboxDestroyer
          .destroy(sandboxId)
          .catch((cleanupError) => {
            log.warn(
              { sandboxId, error: cleanupError },
              "Failed to cleanup prebuild sandbox",
            );
          });
      }

      if (scenario.kind === "workspace") {
        const current = scenario.getWorkspace();
        if (current) {
          scenario.updateStatus(isCancelled ? "none" : "failed");
        }
      }

      if (!isCancelled) {
        throw error;
      }
    } finally {
      this.activeBuilds.delete(key);
    }
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

  private async captureCommitHashes(
    sandboxId: string,
    workspace: Workspace,
  ): Promise<Record<string, string>> {
    const hashes: Record<string, string> = {};

    if (!workspace.config.repos?.length) {
      return hashes;
    }

    for (const repo of workspace.config.repos) {
      const clonePath = repo.clonePath.startsWith("/")
        ? repo.clonePath
        : `/${repo.clonePath}`;
      const fullPath = `${VM.HOME}${clonePath}`;

      const result = await this.deps.agentClient.exec(
        sandboxId,
        `git -C ${fullPath} rev-parse HEAD`,
        { timeout: 10000, user: "dev" },
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

  private async runInitCommands(
    sandboxId: string,
    workspace: Workspace,
  ): Promise<void> {
    const initCommands = workspace.config.initCommands;
    if (!initCommands || initCommands.length === 0) {
      log.info({ workspaceId: workspace.id }, "No init commands to run");
      return;
    }

    log.info(
      { workspaceId: workspace.id, commandCount: initCommands.length },
      "Running init commands",
    );

    for (const command of initCommands) {
      log.info(
        { workspaceId: workspace.id, command },
        "Executing init command",
      );

      const result = await this.deps.agentClient.exec(sandboxId, command, {
        timeout: COMMAND_TIMEOUT,
        user: "dev",
        workdir: WORKSPACE_DIR,
      });

      if (result.exitCode !== 0) {
        log.error(
          {
            workspaceId: workspace.id,
            command,
            exitCode: result.exitCode,
            stderr: result.stderr,
          },
          "Init command failed",
        );
        throw new Error(`Init command failed: ${command}\n${result.stderr}`);
      }

      log.debug(
        { workspaceId: workspace.id, command, stdout: result.stdout },
        "Init command completed",
      );
    }

    log.info({ workspaceId: workspace.id }, "All init commands completed");

    log.info({ workspaceId: workspace.id }, "Fixing workspace ownership");
    await this.deps.agentClient.exec(
      sandboxId,
      `chown -R dev:dev ${WORKSPACE_DIR}`,
      { timeout: COMMAND_TIMEOUT },
    );
  }
}
