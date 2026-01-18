import { nanoid } from "nanoid";
import { createChildLogger } from "../lib/logger.ts";
import { WorkspaceRepository } from "../state/database.ts";
import type {
  PrebuildStatus,
  Workspace,
  WorkspaceConfig,
} from "../types/index.ts";
import { AgentClient } from "./agent.ts";
import { FirecrackerService } from "./firecracker.ts";
import { StorageService } from "./storage.ts";

const log = createChildLogger("prebuild");

const WORKSPACE_DIR = "/home/dev/workspace";
const AGENT_READY_TIMEOUT = 60000;
const COMMAND_TIMEOUT = 300000;

function updatePrebuildStatus(
  workspaceId: string,
  status: PrebuildStatus,
  latestId?: string,
): Workspace | undefined {
  const workspace = WorkspaceRepository.getById(workspaceId);
  if (!workspace) return undefined;

  const prebuild: WorkspaceConfig["prebuild"] = {
    status,
    latestId: latestId ?? workspace.config.prebuild?.latestId,
    builtAt: status === "ready" ? new Date().toISOString() : undefined,
  };

  return WorkspaceRepository.update(workspaceId, {
    config: { ...workspace.config, prebuild },
  });
}

export const PrebuildService = {
  async create(workspaceId: string): Promise<void> {
    const workspace = WorkspaceRepository.getById(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace '${workspaceId}' not found`);
    }

    if (workspace.config.prebuild?.status === "building") {
      throw new Error(
        `Workspace '${workspaceId}' already has a prebuild in progress`,
      );
    }

    updatePrebuildStatus(workspaceId, "building");
    log.info(
      { workspaceId, workspaceName: workspace.name },
      "Starting prebuild",
    );

    const prebuildSandboxId = `prebuild-${nanoid(8)}`;

    try {
      const sandbox = await FirecrackerService.spawn({
        workspaceId,
        baseImage: workspace.config.baseImage,
        vcpus: workspace.config.vcpus,
        memoryMb: workspace.config.memoryMb,
      });

      log.info(
        { prebuildSandboxId: sandbox.id, ip: sandbox.runtime.ipAddress },
        "Prebuild sandbox spawned",
      );

      const agentReady = await AgentClient.waitForAgent(sandbox.id, {
        timeout: AGENT_READY_TIMEOUT,
      });

      if (!agentReady) {
        throw new Error("Agent failed to become ready");
      }

      await this.cloneRepositories(sandbox.id, workspace);
      await this.runInitCommands(sandbox.id, workspace);
      await AgentClient.exec(sandbox.id, "sync");
      await StorageService.createPrebuild(workspaceId, sandbox.id);

      log.info(
        { workspaceId, sandboxId: sandbox.id },
        "Prebuild snapshot created",
      );

      await FirecrackerService.destroy(sandbox.id);

      updatePrebuildStatus(workspaceId, "ready", sandbox.id);
      log.info({ workspaceId }, "Prebuild completed successfully");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log.error({ workspaceId, error: errorMessage }, "Prebuild failed");

      try {
        await FirecrackerService.destroy(prebuildSandboxId);
      } catch (cleanupError) {
        log.warn(
          { prebuildSandboxId, error: cleanupError },
          "Failed to cleanup prebuild sandbox",
        );
      }

      updatePrebuildStatus(workspaceId, "failed");
      throw error;
    }
  },

  async cloneRepositories(
    sandboxId: string,
    workspace: Workspace,
  ): Promise<void> {
    const repos = workspace.config.repos;
    if (!repos || repos.length === 0) {
      log.info({ sandboxId }, "No repositories to clone");
      return;
    }

    for (const repo of repos) {
      const cloneUrl = "url" in repo ? repo.url : repo.repo;
      const branch = repo.branch;
      const clonePath = repo.clonePath || WORKSPACE_DIR;

      log.info(
        { sandboxId, cloneUrl, branch, clonePath },
        "Cloning repository in prebuild sandbox",
      );

      await AgentClient.exec(sandboxId, `rm -rf ${clonePath}`);
      await AgentClient.exec(sandboxId, `mkdir -p $(dirname ${clonePath})`);

      const cloneCmd = `git clone --depth 1 -b ${branch} ${cloneUrl} ${clonePath}`;
      const result = await AgentClient.exec(sandboxId, cloneCmd, {
        timeout: COMMAND_TIMEOUT,
      });

      if (result.exitCode !== 0) {
        log.error(
          { sandboxId, exitCode: result.exitCode, stderr: result.stderr },
          "Git clone failed",
        );
        throw new Error(`Git clone failed: ${result.stderr}`);
      }

      await AgentClient.exec(sandboxId, `chown -R dev:dev ${clonePath}`);
      await AgentClient.exec(
        sandboxId,
        `su - dev -c 'git config --global --add safe.directory ${clonePath}'`,
      );

      log.info({ sandboxId, clonePath }, "Repository cloned successfully");
    }
  },

  async runInitCommands(
    sandboxId: string,
    workspace: Workspace,
  ): Promise<void> {
    const initCommands = workspace.config.initCommands;
    if (!initCommands || initCommands.length === 0) {
      log.info({ sandboxId }, "No init commands to run");
      return;
    }

    log.info(
      { sandboxId, commandCount: initCommands.length },
      "Running init commands",
    );

    for (const command of initCommands) {
      log.info({ sandboxId, command }, "Executing init command");

      const result = await AgentClient.exec(
        sandboxId,
        `cd ${WORKSPACE_DIR} && su dev -c '${command.replace(/'/g, "'\\''")}'`,
        { timeout: COMMAND_TIMEOUT },
      );

      if (result.exitCode !== 0) {
        log.error(
          {
            sandboxId,
            command,
            exitCode: result.exitCode,
            stderr: result.stderr,
          },
          "Init command failed",
        );
        throw new Error(`Init command failed: ${command}\n${result.stderr}`);
      }

      log.debug(
        { sandboxId, command, stdout: result.stdout },
        "Init command completed",
      );
    }

    log.info({ sandboxId }, "All init commands completed");
  },

  async createInBackground(workspaceId: string): Promise<void> {
    setImmediate(() => {
      this.create(workspaceId).catch((error) => {
        log.error({ workspaceId, error }, "Background prebuild failed");
      });
    });
  },

  async delete(workspaceId: string): Promise<void> {
    await StorageService.deletePrebuild(workspaceId);
    updatePrebuildStatus(workspaceId, "none");
    log.info({ workspaceId }, "Prebuild deleted");
  },

  async hasPrebuild(workspaceId: string): Promise<boolean> {
    return StorageService.hasPrebuild(workspaceId);
  },
};
