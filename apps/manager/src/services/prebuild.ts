import type { Project } from "@frak-sandbox/shared/types";
import { nanoid } from "nanoid";
import { createChildLogger } from "../lib/logger.ts";
import { projectStore } from "../state/project-store.ts";
import { AgentClient } from "./agent.ts";
import { FirecrackerService } from "./firecracker.ts";
import { GitService } from "./git.ts";
import { StorageService } from "./storage.ts";

const log = createChildLogger("prebuild");

const WORKSPACE_DIR = "/home/dev/workspace";
const AGENT_READY_TIMEOUT = 60000;
const COMMAND_TIMEOUT = 300000;

export const PrebuildService = {
  async create(projectId: string): Promise<void> {
    const project = projectStore.getById(projectId);
    if (!project) {
      throw new Error(`Project '${projectId}' not found`);
    }

    if (project.prebuildStatus === "building") {
      throw new Error(
        `Project '${projectId}' already has a prebuild in progress`,
      );
    }

    projectStore.updatePrebuildStatus(projectId, "building");
    log.info({ projectId, projectName: project.name }, "Starting prebuild");

    const prebuildSandboxId = `prebuild-${nanoid(8)}`;

    try {
      await GitService.updateCache(project.gitUrl);

      const sandbox = await FirecrackerService.spawn({
        id: prebuildSandboxId,
        baseImage: project.baseImage,
        vcpus: project.vcpus,
        memoryMb: project.memoryMb,
      });

      log.info(
        { prebuildSandboxId, ip: sandbox.ipAddress },
        "Prebuild sandbox spawned",
      );

      const agentReady = await AgentClient.waitForAgent(prebuildSandboxId, {
        timeout: AGENT_READY_TIMEOUT,
      });

      if (!agentReady) {
        throw new Error("Agent failed to become ready");
      }

      await this.cloneRepository(prebuildSandboxId, project);
      await this.runInitCommands(prebuildSandboxId, project);
      await StorageService.createPrebuild(projectId, prebuildSandboxId);

      log.info({ projectId, prebuildSandboxId }, "Prebuild snapshot created");

      await FirecrackerService.destroy(prebuildSandboxId);

      projectStore.updatePrebuildStatus(projectId, "ready", prebuildSandboxId);
      log.info({ projectId }, "Prebuild completed successfully");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      log.error({ projectId, error: errorMessage }, "Prebuild failed");

      try {
        await FirecrackerService.destroy(prebuildSandboxId);
      } catch (cleanupError) {
        log.warn(
          { prebuildSandboxId, error: cleanupError },
          "Failed to cleanup prebuild sandbox",
        );
      }

      projectStore.updatePrebuildStatus(projectId, "failed");
      throw error;
    }
  },

  async cloneRepository(sandboxId: string, project: Project): Promise<void> {
    log.info(
      { sandboxId, gitUrl: project.gitUrl, branch: project.defaultBranch },
      "Cloning repository in prebuild sandbox",
    );

    const cloneCmd = `git clone --depth 1 -b ${project.defaultBranch} ${project.gitUrl} ${WORKSPACE_DIR}`;
    const result = await AgentClient.exec(sandboxId, cloneCmd, {
      timeout: COMMAND_TIMEOUT,
    });

    if (result.exitCode !== 0) {
      throw new Error(`Git clone failed: ${result.stderr}`);
    }

    await AgentClient.exec(sandboxId, `chown -R dev:dev ${WORKSPACE_DIR}`);
    await AgentClient.exec(
      sandboxId,
      `su - dev -c 'git config --global --add safe.directory ${WORKSPACE_DIR}'`,
    );

    log.info({ sandboxId }, "Repository cloned successfully");
  },

  async runInitCommands(sandboxId: string, project: Project): Promise<void> {
    if (!project.initCommands || project.initCommands.length === 0) {
      log.info({ sandboxId }, "No init commands to run");
      return;
    }

    log.info(
      { sandboxId, commandCount: project.initCommands.length },
      "Running init commands",
    );

    for (const command of project.initCommands) {
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

  async createInBackground(projectId: string): Promise<void> {
    setImmediate(() => {
      this.create(projectId).catch((error) => {
        log.error({ projectId, error }, "Background prebuild failed");
      });
    });
  },
};
