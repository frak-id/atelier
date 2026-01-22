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
const OPENCODE_HEALTH_TIMEOUT = 120000;
const OPENCODE_PORT = 3000;

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

    if (await StorageService.hasPrebuild(workspaceId)) {
      await StorageService.deletePrebuild(workspaceId);
      log.info(
        { workspaceId },
        "Deleted existing prebuild before regeneration",
      );
    }

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
      const commitHashes = await this.captureCommitHashes(ipAddress, workspace);
      await this.warmupOpencode(ipAddress, workspace.id);
      await this.deps.agentClient.exec(ipAddress, "sync");
      await StorageService.createPrebuild(workspaceId, sandbox.id);

      log.info(
        { workspaceId, sandboxId: sandbox.id },
        "Prebuild snapshot created",
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
  }

  private async captureCommitHashes(
    ipAddress: string,
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
      const fullPath = `/home/dev${clonePath}`;

      const result = await this.deps.agentClient.exec(
        ipAddress,
        `git -C ${fullPath} rev-parse HEAD`,
        { timeout: 10000 },
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

  /**
   * Opencode installs plugin dependencies (like jose via @openauthjs/openauth) on first boot.
   * We start it briefly here so those packages are cached in the prebuild snapshot.
   */
  private async warmupOpencode(
    ipAddress: string,
    workspaceId: string,
  ): Promise<void> {
    log.info({ workspaceId }, "Warming up opencode server");

    const startResult = await this.deps.agentClient.exec(
      ipAddress,
      `su dev -c 'cd ${WORKSPACE_DIR} && nohup opencode serve --hostname 0.0.0.0 --port ${OPENCODE_PORT} > /tmp/opencode-warmup.log 2>&1 &'`,
      { timeout: 10000 },
    );

    if (startResult.exitCode !== 0) {
      log.warn(
        { workspaceId, stderr: startResult.stderr },
        "Failed to start opencode for warmup, continuing anyway",
      );
      return;
    }

    const startTime = Date.now();
    let healthy = false;

    while (Date.now() - startTime < OPENCODE_HEALTH_TIMEOUT) {
      try {
        const response = await fetch(
          `http://${ipAddress}:${OPENCODE_PORT}/global/health`,
          { signal: AbortSignal.timeout(5000) },
        );

        if (response.ok) {
          const data = (await response.json()) as { healthy?: boolean };
          if (data.healthy) {
            healthy = true;
            log.info({ workspaceId }, "Opencode server is healthy");
            break;
          }
        }
      } catch {}

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (!healthy) {
      log.warn(
        { workspaceId },
        "Opencode did not become healthy within timeout, continuing anyway",
      );
    }

    await this.deps.agentClient.exec(ipAddress, "pkill -f 'opencode serve'", {
      timeout: 5000,
    });

    log.info({ workspaceId }, "Opencode warmup completed");
  }
}
