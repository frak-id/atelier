import { LVM } from "@frak/atelier-shared/constants";
import { $ } from "bun";
import type { AgentClient } from "../infrastructure/agent/index.ts";
import { eventBus } from "../infrastructure/events/index.ts";
import {
  configureVm,
  FirecrackerClient,
  getSandboxPaths,
  getSocketPath,
  getVsockPath,
  launchFirecracker,
} from "../infrastructure/firecracker/index.ts";
import { NetworkService } from "../infrastructure/network/index.ts";
import { CaddyService } from "../infrastructure/proxy/index.ts";
import { SecretsService } from "../infrastructure/secrets/index.ts";
import {
  SharedStorageService,
  StorageService,
} from "../infrastructure/storage/index.ts";
import type { ConfigFileService } from "../modules/config-file/index.ts";
import type { GitSourceService } from "../modules/git-source/index.ts";
import type { InternalService } from "../modules/internal/index.ts";
import type {
  SandboxProvisionService,
  SandboxRepository,
} from "../modules/sandbox/index.ts";
import type { WorkspaceService } from "../modules/workspace/index.ts";
import type { GitHubSourceConfig, Sandbox } from "../schemas/index.ts";
import { NotFoundError } from "../shared/errors.ts";
import { config, isMock } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { cleanupSandboxFiles, killProcess } from "../shared/lib/shell.ts";

const log = createChildLogger("sandbox-lifecycle");

interface SandboxLifecycleDependencies {
  sandboxService: SandboxRepository;
  agentClient: AgentClient;
  internalService: InternalService;
  provisionService: SandboxProvisionService;
  workspaceService: WorkspaceService;
  gitSourceService: GitSourceService;
  configFileService: ConfigFileService;
}

export class SandboxLifecycle {
  constructor(private readonly deps: SandboxLifecycleDependencies) {}

  private async socketExists(path: string): Promise<boolean> {
    const result = await $`test -S ${path}`.quiet().nothrow();
    return result.exitCode === 0;
  }

  private async tryRepairVsock(
    sandboxId: string,
    socketPath: string,
    vsockPath: string,
  ): Promise<boolean> {
    try {
      if (!(await this.socketExists(socketPath))) return false;

      const client = new FirecrackerClient(socketPath);
      await client.setVsock(3, vsockPath);

      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (await this.socketExists(vsockPath)) return true;
        await Bun.sleep(50);
      }
      return await this.socketExists(vsockPath);
    } catch (error) {
      log.warn(
        { sandboxId, socketPath, vsockPath, error },
        "Vsock repair failed",
      );
      return false;
    }
  }

  async stop(sandboxId: string): Promise<Sandbox> {
    const sandbox = this.deps.sandboxService.getById(sandboxId);
    if (!sandbox) {
      throw new NotFoundError("Sandbox", sandboxId);
    }

    if (sandbox.status !== "running") {
      throw new Error(
        `Sandbox '${sandboxId}' is not running (status: ${sandbox.status})`,
      );
    }

    log.info({ sandboxId }, "Stopping sandbox");

    if (!isMock()) {
      if (sandbox.runtime.pid) {
        await killProcess(sandbox.runtime.pid);
      }

      await cleanupSandboxFiles(sandboxId);

      const tapDevice = `tap-${sandboxId.slice(0, 8)}`;
      await NetworkService.deleteTap(tapDevice);
      await CaddyService.removeRoutes(sandboxId);
    }

    this.deps.sandboxService.updateStatus(sandboxId, "stopped");
    eventBus.emit({
      type: "sandbox.updated",
      properties: { id: sandboxId, status: "stopped" },
    });
    log.info({ sandboxId }, "Sandbox stopped");

    const updated = this.deps.sandboxService.getById(sandboxId);
    if (!updated) {
      throw new Error(`Sandbox not found after stop: ${sandboxId}`);
    }
    return updated;
  }

  async start(sandboxId: string): Promise<Sandbox> {
    const sandbox = this.deps.sandboxService.getById(sandboxId);
    if (!sandbox) {
      throw new NotFoundError("Sandbox", sandboxId);
    }

    if (sandbox.status !== "stopped") {
      throw new Error(
        `Sandbox '${sandboxId}' is not stopped (status: ${sandbox.status})`,
      );
    }

    log.info({ sandboxId }, "Starting sandbox");

    if (isMock()) {
      this.deps.sandboxService.updateStatus(sandboxId, "running");
      eventBus.emit({
        type: "sandbox.updated",
        properties: { id: sandboxId, status: "running" },
      });
      const updated = this.deps.sandboxService.getById(sandboxId);
      if (!updated)
        throw new Error(`Sandbox not found after start: ${sandboxId}`);
      return updated;
    }

    const volumeInfo = await StorageService.getVolumeInfo(sandboxId);
    if (!volumeInfo) {
      throw new Error(
        `Cannot start sandbox '${sandboxId}': LVM volume not found.`,
      );
    }

    const volumePath = `/dev/${LVM.VG_NAME}/${LVM.SANDBOX_PREFIX}${sandboxId}`;
    const paths = getSandboxPaths(sandboxId, volumePath);
    const { macAddress } = sandbox.runtime;
    const tapDevice = `tap-${sandboxId.slice(0, 8)}`;
    await NetworkService.createTap(tapDevice);

    const { pid: proc_pid, client } = await launchFirecracker(paths);
    log.debug({ sandboxId, pid: proc_pid }, "Firecracker process started");

    await configureVm(client, {
      paths,
      macAddress,
      tapDevice,
      vcpus: sandbox.runtime.vcpus,
      memoryMb: sandbox.runtime.memoryMb,
    });
    log.debug({ sandboxId }, "VM configured");

    await client.start();
    await this.waitForBoot(client);
    log.debug({ sandboxId }, "VM booted");

    const agentReady = await this.deps.agentClient.waitForAgent(sandboxId, {
      timeout: 60000,
    });

    if (!agentReady) {
      log.warn({ sandboxId }, "Agent did not become ready after restart");
    } else {
      await this.reprovisionGuest(sandboxId, sandbox);
    }

    await CaddyService.registerRoutes(sandboxId, sandbox.runtime.ipAddress, {
      vscode: config.advanced.vm.vscode.port,
      opencode: config.advanced.vm.opencode.port,
    });

    const updatedSandbox: Sandbox = {
      ...sandbox,
      status: "running",
      runtime: {
        ...sandbox.runtime,
        pid: proc_pid,
      },
      updatedAt: new Date().toISOString(),
    };

    this.deps.sandboxService.update(sandboxId, updatedSandbox);
    eventBus.emit({
      type: "sandbox.updated",
      properties: { id: sandboxId, status: "running" },
    });
    log.info({ sandboxId, pid: proc_pid }, "Sandbox started");

    return updatedSandbox;
  }

  /**
   * Re-provision guest after a stop/start cycle.
   *
   * When a VM boots from its LVM volume (not a snapshot resume), all ephemeral
   * state is gone: network config, clock, /opt/shared mount, services.
   * This mirrors SandboxSpawner.reconfigureRestoredGuest().
   */
  private async reprovisionGuest(
    sandboxId: string,
    sandbox: Sandbox,
  ): Promise<void> {
    const { provisionService } = this.deps;

    // 1. Configure guest network
    await provisionService.configureNetwork(sandboxId, {
      ipAddress: sandbox.runtime.ipAddress,
      gateway: config.network.bridgeIp,
    });

    // 2. Sync clock (restart chronyd)
    await provisionService.syncClock(sandboxId);

    // 3. Push runtime env
    await provisionService.pushRuntimeEnv(sandboxId, {
      ATELIER_SANDBOX_ID: sandboxId,
    });

    // 4. Set hostname
    await provisionService.setHostname(sandboxId, `sandbox-${sandboxId}`);

    // 5. Mount shared binaries (/opt/shared)
    const imageInfo = await SharedStorageService.getBinariesImageInfo();
    if (imageInfo.exists) {
      const mountResult = await this.deps.agentClient.exec(
        sandboxId,
        "mknod -m 444 /dev/vdb b 254 16 2>/dev/null; mkdir -p /opt/shared && mount -o ro /dev/vdb /opt/shared",
        { timeout: 5000 },
      );
      if (mountResult.exitCode === 0) {
        log.info({ sandboxId }, "Shared binaries mounted");
      } else {
        log.warn(
          { sandboxId, stderr: mountResult.stderr },
          "Failed to mount shared binaries",
        );
      }
    }

    // 6. Push auth, configs, and registry
    await this.deps.internalService.syncAllToSandbox(sandboxId);

    // 7. Re-push secrets (may have changed since last boot)
    await this.pushSecrets(sandboxId, sandbox);
    await this.pushGitCredentials(sandboxId);
    await this.pushFileSecrets(sandboxId, sandbox);

    // 8. Start services (vscode, opencode)
    const serviceNames = ["vscode", "opencode"];
    await provisionService.startServices(sandboxId, serviceNames);

    log.info({ sandboxId }, "Guest re-provisioned after restart");
  }

  private async pushSecrets(
    sandboxId: string,
    sandbox: Sandbox,
  ): Promise<void> {
    if (!sandbox.workspaceId) return;
    const workspace = this.deps.workspaceService.getById(sandbox.workspaceId);
    const secrets = workspace?.config.secrets;
    if (!secrets || Object.keys(secrets).length === 0) return;

    const decrypted = await SecretsService.decryptSecrets(secrets);
    const envFile = SecretsService.generateEnvFile(decrypted);
    await this.deps.provisionService.pushSecrets(sandboxId, envFile);
  }

  private async pushGitCredentials(sandboxId: string): Promise<void> {
    const sources = this.deps.gitSourceService.getAll();
    const credentials: string[] = [];

    for (const source of sources) {
      if (source.type === "github") {
        const ghConfig = source.config as GitHubSourceConfig;
        if (ghConfig.accessToken) {
          credentials.push(
            `https://x-access-token:${ghConfig.accessToken}@github.com`,
          );
        }
      }
    }

    await this.deps.provisionService.pushGitConfig(sandboxId, credentials);
  }

  private async pushFileSecrets(
    sandboxId: string,
    sandbox: Sandbox,
  ): Promise<void> {
    if (!sandbox.workspaceId) return;
    const workspace = this.deps.workspaceService.getById(sandbox.workspaceId);
    const fileSecrets = workspace?.config.fileSecrets;
    if (!fileSecrets || fileSecrets.length === 0) return;

    const decrypted = await SecretsService.decryptFileSecrets(fileSecrets);
    await this.deps.provisionService.pushFileSecrets(
      sandboxId,
      decrypted.map((s) => ({
        path: s.path,
        content: s.content,
        mode: s.mode,
      })),
    );
  }

  private async waitForBoot(
    client: FirecrackerClient,
    timeoutMs = 30000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        if (await client.isRunning()) return;
      } catch {}
      await Bun.sleep(50);
    }

    throw new Error(`VM boot timeout after ${timeoutMs}ms`);
  }

  async getStatus(sandboxId: string): Promise<Sandbox | undefined> {
    const sandbox = this.deps.sandboxService.getById(sandboxId);
    if (!sandbox) {
      return undefined;
    }

    if (isMock() || !sandbox.runtime.pid) {
      return sandbox;
    }

    if (sandbox.status === "stopped") {
      return sandbox;
    }

    const socketPath = getSocketPath(sandboxId);
    const vsockPath = getVsockPath(sandboxId);
    const processAlive = await $`kill -0 ${sandbox.runtime.pid}`
      .quiet()
      .nothrow();
    const [apiSocketExists, vsockExists] = await Promise.all([
      this.socketExists(socketPath),
      this.socketExists(vsockPath),
    ]);

    if (processAlive.exitCode !== 0) {
      log.warn(
        {
          sandboxId,
          pid: sandbox.runtime.pid,
          socketPath,
          apiSocketExists,
          vsockPath,
          vsockExists,
        },
        "Firecracker process dead, marking as error",
      );
      this.deps.sandboxService.updateStatus(
        sandboxId,
        "error",
        "Firecracker process is not running",
      );
    } else if (!vsockExists) {
      const repaired = await this.tryRepairVsock(
        sandboxId,
        socketPath,
        vsockPath,
      );
      if (repaired) {
        log.info({ sandboxId, vsockPath }, "Vsock repaired");
        this.clearRuntimeError(sandboxId, sandbox);
      } else {
        log.warn(
          { sandboxId, socketPath, vsockPath },
          "Vsock missing and repair failed, setting runtime error",
        );
        this.setRuntimeError(
          sandboxId,
          "Vsock unavailable — agent communication degraded",
        );
      }
    } else if (!apiSocketExists) {
      log.warn(
        { sandboxId, socketPath, vsockPath },
        "Firecracker API socket missing but agent reachable",
      );
    } else if (sandbox.runtime.error) {
      this.clearRuntimeError(sandboxId, sandbox);
    }

    return this.deps.sandboxService.getById(sandboxId) ?? sandbox;
  }

  private setRuntimeError(sandboxId: string, error: string): void {
    const current = this.deps.sandboxService.getById(sandboxId);
    if (!current) return;
    this.deps.sandboxService.update(sandboxId, {
      runtime: { ...current.runtime, error },
    });
  }

  private clearRuntimeError(sandboxId: string, sandbox?: Sandbox): void {
    const current = sandbox ?? this.deps.sandboxService.getById(sandboxId);
    if (!current?.runtime.error) return;
    const { error: _removed, ...cleanRuntime } = current.runtime;
    this.deps.sandboxService.update(sandboxId, {
      runtime: cleanRuntime,
    });
    log.info({ sandboxId }, "Cleared stale runtime error");
  }

  async getFirecrackerState(sandboxId: string): Promise<unknown> {
    if (isMock()) {
      return { mock: true, sandboxId };
    }

    const socketPath = getSocketPath(sandboxId);
    if (!(await this.socketExists(socketPath))) {
      return { error: "Socket not found", sandboxId };
    }

    try {
      const client = new FirecrackerClient(socketPath);
      return await client.getState();
    } catch {
      return { error: "Failed to query Firecracker", sandboxId };
    }
  }
}
