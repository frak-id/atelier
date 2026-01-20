import type { AgentClient } from "../infrastructure/agent/index.ts";
import { StorageService } from "../infrastructure/storage/index.ts";
import type { SandboxService } from "../modules/sandbox/index.ts";
import type { WorkspaceService } from "../modules/workspace/index.ts";
import type {
  PrebuildStatus,
  Workspace,
  WorkspaceConfig,
} from "../schemas/index.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { SandboxDestroyer } from "./sandbox-destroyer.ts";
import type { SandboxSpawner } from "./sandbox-spawner.ts";

const log = createChildLogger("prebuild-runner");

const WORKSPACE_DIR = "/home/dev/workspace";
const AGENT_READY_TIMEOUT = 60000;
const COMMAND_TIMEOUT = 300000;

interface PrebuildRunnerDependencies {
  sandboxSpawner: SandboxSpawner;
  sandboxDestroyer: SandboxDestroyer;
  sandboxService: SandboxService;
  workspaceService: WorkspaceService;
  agentClient: AgentClient;
}

export class PrebuildRunner {
  constructor(private readonly deps: PrebuildRunnerDependencies) {}

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

    this.updatePrebuildStatus(workspaceId, workspace, "building");
    log.info(
      { workspaceId, workspaceName: workspace.name },
      "Starting prebuild",
    );

    let sandboxId: string | undefined;

    try {
      const sandbox = await this.deps.sandboxSpawner.spawn({
        workspaceId,
        baseImage: workspace.config.baseImage,
        vcpus: workspace.config.vcpus,
        memoryMb: workspace.config.memoryMb,
      });

      sandboxId = sandbox.id;
      const ipAddress = sandbox.runtime.ipAddress;

      log.info(
        { prebuildSandboxId: sandbox.id, ip: ipAddress },
        "Prebuild sandbox spawned",
      );

      const agentReady = await this.deps.agentClient.waitForAgent(ipAddress, {
        timeout: AGENT_READY_TIMEOUT,
      });

      if (!agentReady) {
        throw new Error("Agent failed to become ready");
      }

      await this.runInitCommands(ipAddress, workspace);
      await this.deps.agentClient.exec(ipAddress, "sync");
      await StorageService.createPrebuild(workspaceId, sandbox.id);

      log.info(
        { workspaceId, sandboxId: sandbox.id },
        "Prebuild snapshot created",
      );

      await this.deps.sandboxDestroyer.destroy(sandbox.id);

      this.updatePrebuildStatus(workspaceId, workspace, "ready", sandbox.id);
      log.info({ workspaceId }, "Prebuild completed successfully");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log.error({ workspaceId, error: errorMessage }, "Prebuild failed");

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

      this.updatePrebuildStatus(workspaceId, workspace, "failed");
      throw error;
    }
  }

  runInBackground(workspaceId: string): void {
    setImmediate(() => {
      this.run(workspaceId).catch((error) => {
        log.error({ workspaceId, error }, "Background prebuild failed");
      });
    });
  }

  async delete(workspaceId: string): Promise<void> {
    const workspace = this.deps.workspaceService.getById(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace '${workspaceId}' not found`);
    }

    await StorageService.deletePrebuild(workspaceId);
    this.updatePrebuildStatus(workspaceId, workspace, "none");
    log.info({ workspaceId }, "Prebuild deleted");
  }

  async hasPrebuild(workspaceId: string): Promise<boolean> {
    return StorageService.hasPrebuild(workspaceId);
  }

  private updatePrebuildStatus(
    workspaceId: string,
    workspace: Workspace,
    status: PrebuildStatus,
    latestId?: string,
  ): void {
    const prebuild: WorkspaceConfig["prebuild"] = {
      status,
      latestId: latestId ?? workspace.config.prebuild?.latestId,
      builtAt: status === "ready" ? new Date().toISOString() : undefined,
    };

    this.deps.workspaceService.update(workspaceId, {
      config: { ...workspace.config, prebuild },
    });
  }

  private async runInitCommands(
    ipAddress: string,
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

      const result = await this.deps.agentClient.exec(
        ipAddress,
        `cd ${WORKSPACE_DIR} && su dev -c '${command.replace(/'/g, "'\\''")}'`,
        { timeout: COMMAND_TIMEOUT },
      );

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
      ipAddress,
      `chown -R dev:dev ${WORKSPACE_DIR}`,
      { timeout: COMMAND_TIMEOUT },
    );
  }
}
