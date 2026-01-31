import { $ } from "bun";
import type { AgentClient } from "../infrastructure/agent/index.ts";
import {
  FirecrackerClient,
  getPrebuildSnapshotPaths,
  getSocketPath,
} from "../infrastructure/firecracker/index.ts";
import { StorageService } from "../infrastructure/storage/index.ts";
import type { InternalService } from "../modules/internal/internal.service.ts";
import type { SandboxRepository } from "../modules/sandbox/index.ts";
import type { WorkspaceService } from "../modules/workspace/index.ts";
import type {
  PrebuildStatus,
  Workspace,
  WorkspaceConfig,
} from "../schemas/index.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { ensureDir } from "../shared/lib/shell.ts";
import type { SandboxDestroyer } from "./sandbox-destroyer.ts";
import type { SandboxSpawner } from "./sandbox-spawner.ts";

const log = createChildLogger("prebuild-runner");

const WORKSPACE_DIR = "/home/dev/workspace";
const AGENT_READY_TIMEOUT = 60000;
const COMMAND_TIMEOUT = 300000;
const OPENCODE_HEALTH_TIMEOUT = 120000;

interface PrebuildRunnerDependencies {
  sandboxSpawner: SandboxSpawner;
  sandboxDestroyer: SandboxDestroyer;
  sandboxService: SandboxRepository;
  workspaceService: WorkspaceService;
  agentClient: AgentClient;
  internalService: InternalService;
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
      await this.deleteVmSnapshot(workspaceId);
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

      log.info({ prebuildSandboxId: sandbox.id }, "Prebuild sandbox spawned");

      const agentReady = await this.deps.agentClient.waitForAgent(sandbox.id, {
        timeout: AGENT_READY_TIMEOUT,
      });

      if (!agentReady) {
        throw new Error("Agent failed to become ready");
      }

      await this.runInitCommands(sandbox.id, workspace);
      const commitHashes = await this.captureCommitHashes(
        sandbox.id,
        workspace,
      );
      await this.warmupOpencode(sandbox.id, workspace.id);

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
    await this.deleteVmSnapshot(workspaceId);
    this.updatePrebuildStatus(workspaceId, workspace, "none");
    log.info({ workspaceId }, "Prebuild deleted");
  }

  private async createVmSnapshot(
    workspaceId: string,
    sandboxId: string,
  ): Promise<void> {
    if (config.isMock()) {
      log.debug({ workspaceId }, "Mock: VM snapshot creation skipped");
      return;
    }

    const snapshotPaths = getPrebuildSnapshotPaths(workspaceId);
    const socketPath = getSocketPath(sandboxId);
    const client = new FirecrackerClient(socketPath);

    await ensureDir(`${config.paths.SANDBOX_DIR}/snapshots`);

    log.info({ workspaceId, sandboxId }, "Creating VM snapshot");
    await client.createSnapshot(
      snapshotPaths.snapshotFile,
      snapshotPaths.memFile,
    );
    log.info({ workspaceId }, "VM snapshot created");
  }

  private async deleteVmSnapshot(workspaceId: string): Promise<void> {
    if (config.isMock()) return;

    const snapshotPaths = getPrebuildSnapshotPaths(workspaceId);
    await $`rm -f ${snapshotPaths.snapshotFile} ${snapshotPaths.memFile}`
      .quiet()
      .nothrow();
  }

  async hasVmSnapshot(workspaceId: string): Promise<boolean> {
    if (config.isMock()) return false;

    const snapshotPaths = getPrebuildSnapshotPaths(workspaceId);
    const snapExists = await Bun.file(snapshotPaths.snapshotFile).exists();
    const memExists = await Bun.file(snapshotPaths.memFile).exists();
    return snapExists && memExists;
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
      const fullPath = `/home/dev${clonePath}`;

      const result = await this.deps.agentClient.exec(
        sandboxId,
        `su dev -c 'git -C ${fullPath} rev-parse HEAD'`,
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

      const result = await this.deps.agentClient.exec(
        sandboxId,
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
      sandboxId,
      `chown -R dev:dev ${WORKSPACE_DIR}`,
      { timeout: COMMAND_TIMEOUT },
    );
  }

  /**
   * Opencode installs plugin dependencies (like jose via @openauthjs/openauth) on first boot.
   * We start it briefly here so those packages are cached in the prebuild snapshot.
   */
  /**
   * Prepare VM for clean snapshot by stopping services.
   * The agent survives the snapshot (vsock listener persists across FC snapshots).
   * Services are restored post-restore by the spawner.
   */
  private async pushLatestAuthAndConfigs(sandboxId: string): Promise<void> {
    const [authResult, configResult] = await Promise.allSettled([
      this.deps.internalService.syncAuthToSandbox(sandboxId),
      this.deps.internalService.syncConfigsToSandbox(sandboxId),
    ]);

    if (authResult.status === "fulfilled") {
      log.info(
        { sandboxId, synced: authResult.value.synced },
        "Auth baked into prebuild",
      );
    } else {
      log.warn(
        { sandboxId, error: authResult.reason },
        "Failed to push auth before prebuild snapshot",
      );
    }

    if (configResult.status === "fulfilled") {
      log.info(
        { sandboxId, synced: configResult.value.synced },
        "Configs baked into prebuild",
      );
    } else {
      log.warn(
        { sandboxId, error: configResult.reason },
        "Failed to push configs before prebuild snapshot",
      );
    }
  }

  private async prepareForSnapshot(sandboxId: string): Promise<void> {
    log.info({ sandboxId }, "Preparing VM for snapshot");

    // Kill services that hold state (opencode, code-server, ttyd)
    // Agent is NOT killed — its vsock listener survives snapshot restore
    await this.deps.agentClient.exec(
      sandboxId,
      "pkill -f 'opencode serve'; pkill -f code-server; pkill -f ttyd",
      { timeout: 5000 },
    );

    // Flush filesystem buffers
    await this.deps.agentClient.exec(sandboxId, "sync", { timeout: 5000 });

    log.info({ sandboxId }, "VM prepared for snapshot");
  }

  private async warmupOpencode(
    sandboxId: string,
    workspaceId: string,
  ): Promise<void> {
    log.info({ workspaceId }, "Warming up opencode server");

    const port = config.raw.services.opencode.port;
    // Use nohup + setsid + explicit fd close to fully detach from the shell.
    // Without closing fds 1&2 at the outer sh level, Deno.Command's piped
    // stdout stays open until the background process exits → timeout.
    const startResult = await this.deps.agentClient.exec(
      sandboxId,
      `su dev -c 'cd ${WORKSPACE_DIR} && nohup setsid opencode serve --hostname 0.0.0.0 --port ${port} </dev/null >/tmp/opencode-warmup.log 2>&1 &' </dev/null >/dev/null 2>&1`,
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
        const result = await this.deps.agentClient.exec(
          sandboxId,
          `curl -sf http://localhost:${port}/global/health`,
          { timeout: 5000 },
        );
        if (result.exitCode === 0 && result.stdout.includes("healthy")) {
          healthy = true;
          log.info({ workspaceId }, "Opencode server is healthy");
          break;
        }
      } catch {}

      await Bun.sleep(2000);
    }

    if (!healthy) {
      log.warn(
        { workspaceId },
        "Opencode did not become healthy within timeout, continuing anyway",
      );
    }

    await this.deps.agentClient.exec(sandboxId, "pkill -f 'opencode serve'", {
      timeout: 5000,
    });

    log.info({ workspaceId }, "Opencode warmup completed");
  }
}
