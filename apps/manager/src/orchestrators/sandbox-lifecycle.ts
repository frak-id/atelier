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
import { StorageService } from "../infrastructure/storage/index.ts";
import type { InternalService } from "../modules/internal/index.ts";
import type { SandboxRepository } from "../modules/sandbox/index.ts";
import type { Sandbox } from "../schemas/index.ts";
import { NotFoundError } from "../shared/errors.ts";
import { config, isMock } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { cleanupSandboxFiles, killProcess } from "../shared/lib/shell.ts";

const log = createChildLogger("sandbox-lifecycle");

interface SandboxLifecycleDependencies {
  sandboxService: SandboxRepository;
  agentClient: AgentClient;
  internalService: InternalService;
}

export class SandboxLifecycle {
  constructor(private readonly deps: SandboxLifecycleDependencies) {}

  private async tryRepairVsock(
    sandboxId: string,
    socketPath: string,
    vsockPath: string,
  ): Promise<boolean> {
    try {
      const apiSocketExists = await Bun.file(socketPath).exists();
      if (!apiSocketExists) return false;

      const client = new FirecrackerClient(socketPath);
      await client.setVsock(3, vsockPath);

      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (await Bun.file(vsockPath).exists()) return true;
        await Bun.sleep(50);
      }
      return await Bun.file(vsockPath).exists();
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
      await this.deps.internalService.syncToSandbox(sandboxId);
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
    const apiSocketExists = await Bun.file(socketPath).exists();
    const vsockExists = await Bun.file(vsockPath).exists();

    if (processAlive.exitCode !== 0) {
      log.warn(
        {
          sandboxId,
          pid: sandbox.runtime.pid,
          processAlive: processAlive.exitCode === 0,
          socketPath,
          apiSocketExists,
          vsockPath,
          vsockExists,
        },
        "Sandbox liveness check failed, marking as error",
      );
      this.deps.sandboxService.updateStatus(sandboxId, "error");
    } else if (!apiSocketExists && !vsockExists) {
      log.warn(
        {
          sandboxId,
          pid: sandbox.runtime.pid,
          socketPath,
          apiSocketExists,
          vsockPath,
          vsockExists,
        },
        "Sandbox sockets missing, marking as error",
      );
      this.deps.sandboxService.updateStatus(sandboxId, "error");
    } else if (!vsockExists) {
      const repaired = await this.tryRepairVsock(
        sandboxId,
        socketPath,
        vsockPath,
      );
      if (repaired) {
        log.info({ sandboxId, vsockPath }, "Vsock repaired");
      } else {
        log.warn(
          { sandboxId, socketPath, vsockPath },
          "Vsock missing and repair failed, marking as error",
        );
        this.deps.sandboxService.updateStatus(sandboxId, "error");
      }
    } else if (!apiSocketExists) {
      log.warn(
        { sandboxId, socketPath, vsockPath },
        "Firecracker API socket missing but agent reachable",
      );
    }

    return this.deps.sandboxService.getById(sandboxId) ?? sandbox;
  }

  async getFirecrackerState(sandboxId: string): Promise<unknown> {
    if (isMock()) {
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
