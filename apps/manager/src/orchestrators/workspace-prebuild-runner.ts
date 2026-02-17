import { VM } from "@frak/atelier-shared/constants";
import { eventBus } from "../infrastructure/events/index.ts";
import { StorageService } from "../infrastructure/storage/index.ts";
import type { WorkspaceService } from "../modules/workspace/index.ts";
import type {
  PrebuildStatus,
  Workspace,
  WorkspaceConfig,
} from "../schemas/index.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import {
  PrebuildRunner,
  type PrebuildRunnerDependencies,
} from "./prebuild-runner.ts";

const log = createChildLogger("prebuild-runner");

const WORKSPACE_DIR = VM.WORKSPACE_DIR;
const AGENT_READY_TIMEOUT = 60000;
const COMMAND_TIMEOUT = 300000;

interface WorkspacePrebuildRunnerDependencies
  extends PrebuildRunnerDependencies {
  workspaceService: WorkspaceService;
}

export class WorkspacePrebuildRunner extends PrebuildRunner {
  constructor(
    protected override readonly deps: WorkspacePrebuildRunnerDependencies,
  ) {
    super(deps);
  }

  async run(workspaceId: string): Promise<void> {
    const workspace = this.deps.workspaceService.getById(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace '${workspaceId}' not found`);
    }

    if (workspace.config.prebuild?.status === "building") {
      throw new Error(
        `Workspace '${workspaceId}' already has a prebuild in progress`,
      );
    }

    const abortController = new AbortController();
    this.activeBuilds.set(workspaceId, { abortController });

    this.updatePrebuildStatus(workspaceId, workspace, "building");
    log.info(
      { workspaceId, workspaceName: workspace.name },
      "Starting prebuild",
    );

    if (await StorageService.hasPrebuild(workspaceId)) {
      await StorageService.deletePrebuild(workspaceId);
      await this.deleteVmSnapshot(workspaceId);
      log.info(
        { workspaceId },
        "Deleted existing prebuild before regeneration",
      );
    }

    let sandboxId: string | undefined;

    try {
      this.throwIfAborted(workspaceId);

      const sandbox = await this.deps.sandboxSpawner.spawn({
        workspaceId,
        baseImage: workspace.config.baseImage,
        vcpus: workspace.config.vcpus,
        memoryMb: workspace.config.memoryMb,
      });

      sandboxId = sandbox.id;
      const activeBuild = this.activeBuilds.get(workspaceId);
      if (activeBuild) {
        activeBuild.sandboxId = sandboxId;
      }

      log.info({ prebuildSandboxId: sandbox.id }, "Prebuild sandbox spawned");

      this.throwIfAborted(workspaceId);

      const agentReady = await this.deps.agentClient.waitForAgent(sandbox.id, {
        timeout: AGENT_READY_TIMEOUT,
      });

      if (!agentReady) {
        throw new Error("Agent failed to become ready");
      }

      this.throwIfAborted(workspaceId);
      await this.runInitCommands(sandbox.id, workspace);

      this.throwIfAborted(workspaceId);
      const commitHashes = await this.captureCommitHashes(
        sandbox.id,
        workspace,
      );

      this.throwIfAborted(workspaceId);
      await this.warmupOpencode(
        sandbox.id,
        workspace.id,
        sandbox.runtime.ipAddress,
      );

      this.throwIfAborted(workspaceId);
      await this.pushLatestAuthAndConfigs(sandbox.id);
      await this.prepareForSnapshot(sandbox.id);
      await this.createVmSnapshot(workspaceId, sandbox.id);
      await StorageService.createPrebuild(workspaceId, sandbox.id);

      log.info(
        { workspaceId, sandboxId: sandbox.id },
        "Prebuild snapshot created (LVM + VM state)",
      );

      await this.deps.sandboxDestroyer.destroy(sandbox.id);

      this.updatePrebuildStatus(
        workspaceId,
        workspace,
        "ready",
        sandbox.id,
        commitHashes,
      );
      log.info({ workspaceId }, "Prebuild completed successfully");
    } catch (error) {
      const isCancelled = error instanceof Error && error.name === "AbortError";
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (isCancelled) {
        log.info({ workspaceId }, "Prebuild cancelled");
      } else {
        log.error({ workspaceId, error: errorMessage }, "Prebuild failed");
      }

      if (sandboxId) {
        try {
          await this.deps.sandboxDestroyer.destroy(sandboxId);
        } catch (cleanupError) {
          log.warn(
            { sandboxId, error: cleanupError },
            "Failed to cleanup prebuild sandbox",
          );
        }
      }

      try {
        await this.deleteVmSnapshot(workspaceId);
      } catch (cleanupError) {
        log.warn(
          { workspaceId, error: cleanupError },
          "Failed to cleanup partial VM snapshot",
        );
      }

      this.updatePrebuildStatus(
        workspaceId,
        workspace,
        isCancelled ? "none" : "failed",
      );

      if (!isCancelled) {
        throw error;
      }
    } finally {
      this.activeBuilds.delete(workspaceId);
    }
  }

  runInBackground(workspaceId: string): void {
    setImmediate(() => {
      this.run(workspaceId).catch((error) => {
        log.error({ workspaceId, error }, "Background prebuild failed");
      });
    });
  }

  async cancel(workspaceId: string): Promise<void> {
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

    try {
      await this.deleteVmSnapshot(workspaceId);
    } catch (cleanupError) {
      log.warn(
        { workspaceId, error: cleanupError },
        "Failed to cleanup VM snapshot during force-reset",
      );
    }

    this.updatePrebuildStatus(workspaceId, workspace, "none");
  }

  async delete(workspaceId: string): Promise<void> {
    const workspace = this.deps.workspaceService.getById(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace '${workspaceId}' not found`);
    }

    await this.cleanupStorage(workspaceId);
    this.updatePrebuildStatus(workspaceId, workspace, "none");
    log.info({ workspaceId }, "Prebuild deleted");
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
