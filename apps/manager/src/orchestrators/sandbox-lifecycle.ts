import { FIRECRACKER, LVM } from "@frak-sandbox/shared/constants";
import { $ } from "bun";
import type { AgentClient } from "../infrastructure/agent/index.ts";
import {
  FirecrackerClient,
  getSandboxPaths,
  getSocketPath,
  getVsockPath,
} from "../infrastructure/firecracker/index.ts";
import { NetworkService } from "../infrastructure/network/index.ts";
import { CaddyService } from "../infrastructure/proxy/index.ts";
import {
  BINARIES_IMAGE_PATH,
  SharedStorageService,
  StorageService,
} from "../infrastructure/storage/index.ts";
import type { InternalService } from "../modules/internal/index.ts";
import type { SandboxService } from "../modules/sandbox/index.ts";
import type { Sandbox } from "../schemas/index.ts";
import { NotFoundError } from "../shared/errors.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { ensureDir } from "../shared/lib/shell.ts";

const log = createChildLogger("sandbox-lifecycle");

interface SandboxLifecycleDependencies {
  sandboxService: SandboxService;
  agentClient: AgentClient;
  internalService: InternalService;
}

export class SandboxLifecycle {
  constructor(private readonly deps: SandboxLifecycleDependencies) {}

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

    if (!config.isMock()) {
      if (sandbox.runtime.pid) {
        await $`kill ${sandbox.runtime.pid} 2>/dev/null || true`
          .quiet()
          .nothrow();
        await Bun.sleep(500);
        await $`kill -9 ${sandbox.runtime.pid} 2>/dev/null || true`
          .quiet()
          .nothrow();
      }

      const socketPath = getSocketPath(sandboxId);
      const vsockPath = getVsockPath(sandboxId);
      const pidPath = `${config.paths.SOCKET_DIR}/${sandboxId}.pid`;
      await $`rm -f ${socketPath} ${vsockPath} ${pidPath}`.quiet().nothrow();

      const tapDevice = `tap-${sandboxId.slice(0, 8)}`;
      await NetworkService.deleteTap(tapDevice);
      await CaddyService.removeRoutes(sandboxId);
    }

    this.deps.sandboxService.updateStatus(sandboxId, "stopped");
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

    if (config.isMock()) {
      this.deps.sandboxService.updateStatus(sandboxId, "running");
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

    await ensureDir(config.paths.SOCKET_DIR);
    await ensureDir(config.paths.LOG_DIR);
    await $`rm -f ${paths.socket} ${paths.vsock}`.quiet().nothrow();
    await $`touch ${paths.log}`.quiet();

    const proc = Bun.spawn(
      [
        FIRECRACKER.BINARY_PATH,
        "--api-sock",
        paths.socket,
        "--log-path",
        paths.log,
        "--level",
        "Warning",
      ],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );

    await Bun.write(paths.pid, String(proc.pid));
    await Bun.sleep(50);

    const alive = await $`kill -0 ${proc.pid}`.quiet().nothrow();
    if (alive.exitCode !== 0) {
      const logContent = await Bun.file(paths.log)
        .text()
        .catch(() => "");
      log.error({ sandboxId, log: logContent }, "Firecracker failed to start");
      throw new Error("Firecracker process died on startup");
    }

    log.debug({ sandboxId, pid: proc.pid }, "Firecracker process started");

    const client = new FirecrackerClient(paths.socket);
    const bootArgs =
      "console=ttyS0 reboot=k panic=1 pci=off quiet loglevel=1 8250.nr_uarts=0 init=/etc/sandbox/sandbox-init.sh";

    await client.setBootSource(paths.kernel, bootArgs);
    await client.setDrive("rootfs", paths.overlay, true);

    const imageInfo = await SharedStorageService.getBinariesImageInfo();
    if (imageInfo.exists) {
      await client.setDrive("shared", BINARIES_IMAGE_PATH, false, true);
    }

    await client.setNetworkInterface("eth0", macAddress, tapDevice);

    const cpuTemplatePath = `${config.paths.SANDBOX_DIR}/cpu-template-no-avx.json`;
    await client.setCpuConfig(cpuTemplatePath);

    await client.setMachineConfig(
      sandbox.runtime.vcpus,
      sandbox.runtime.memoryMb,
    );

    await client.setVsock(3, paths.vsock);

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
      await Promise.allSettled([
        this.deps.internalService.syncAuthToSandbox(sandboxId),
        this.deps.internalService.syncConfigsToSandbox(sandboxId),
      ]);
    }

    await CaddyService.registerRoutes(sandboxId, sandbox.runtime.ipAddress, {
      vscode: config.raw.services.vscode.port,
      opencode: config.raw.services.opencode.port,
      terminal: config.raw.services.terminal.port,
    });

    const updatedSandbox: Sandbox = {
      ...sandbox,
      status: "running",
      runtime: {
        ...sandbox.runtime,
        pid: proc.pid,
      },
      updatedAt: new Date().toISOString(),
    };

    this.deps.sandboxService.update(sandboxId, updatedSandbox);
    log.info({ sandboxId, pid: proc.pid }, "Sandbox started");

    return updatedSandbox;
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

    if (config.isMock() || !sandbox.runtime.pid) {
      return sandbox;
    }

    if (sandbox.status === "stopped") {
      return sandbox;
    }

    const socketPath = getSocketPath(sandboxId);
    const processAlive = await $`kill -0 ${sandbox.runtime.pid}`
      .quiet()
      .nothrow();
    const socketExists = await Bun.file(socketPath).exists();

    if (processAlive.exitCode !== 0 || !socketExists) {
      log.warn(
        {
          sandboxId,
          pid: sandbox.runtime.pid,
          processAlive: processAlive.exitCode === 0,
          socketPath,
          socketExists,
        },
        "Sandbox liveness check failed, marking as error",
      );
      this.deps.sandboxService.updateStatus(sandboxId, "error");
    }

    return this.deps.sandboxService.getById(sandboxId) ?? sandbox;
  }

  async getFirecrackerState(sandboxId: string): Promise<unknown> {
    if (config.isMock()) {
      return { mock: true, sandboxId };
    }

    const socketPath = getSocketPath(sandboxId);
    if (!(await Bun.file(socketPath).exists())) {
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
