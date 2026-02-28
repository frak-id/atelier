import { LVM } from "@frak/atelier-shared/constants";
import { $ } from "bun";
import { eventBus } from "../infrastructure/events/index.ts";
import {
  configureVm,
  FirecrackerClient,
  getSandboxPaths,
  getSocketPath,
  getVsockPath,
  launchFirecracker,
} from "../infrastructure/firecracker/index.ts";
import { networkService } from "../infrastructure/network/index.ts";
import { proxyService } from "../infrastructure/proxy/index.ts";
import { StorageService } from "../infrastructure/storage/index.ts";
import type { Sandbox } from "../schemas/index.ts";
import { NotFoundError } from "../shared/errors.ts";
import { config, isMock } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { cleanupSandboxFiles, killProcess } from "../shared/lib/shell.ts";
import { waitForBoot } from "./kernel/boot-waiter.ts";
import type { SandboxPorts } from "./ports/sandbox-ports.ts";
import {
  provisionSystemRestart,
  provisionWorkspaceRestart,
} from "./workflows/index.ts";

const log = createChildLogger("sandbox-lifecycle");

interface SandboxLifecycleDependencies {
  ports: SandboxPorts;
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
    const sandbox = this.deps.ports.sandbox.getById(sandboxId);
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
      await networkService.deleteTap(tapDevice);
      await proxyService.removeRoutes(sandboxId);
    }

    this.deps.ports.sandbox.updateStatus(sandboxId, "stopped");
    eventBus.emit({
      type: "sandbox.updated",
      properties: { id: sandboxId, status: "stopped" },
    });
    log.info({ sandboxId }, "Sandbox stopped");

    const updated = this.deps.ports.sandbox.getById(sandboxId);
    if (!updated) {
      throw new Error(`Sandbox not found after stop: ${sandboxId}`);
    }
    return updated;
  }

  /**
   * Recover a sandbox stuck in error state.
   *
   * Cleans up stale resources (dead process, orphaned sockets, TAP device,
   * Caddy routes) then boots the VM from its LVM volume. The volume survives
   * reboots — only ephemeral resources need rebuilding.
   */
  async recover(sandboxId: string): Promise<Sandbox> {
    const sandbox = this.deps.ports.sandbox.getById(sandboxId);
    if (!sandbox) {
      throw new NotFoundError("Sandbox", sandboxId);
    }

    if (sandbox.status !== "error") {
      throw new Error(
        `Sandbox '${sandboxId}' is not in error state (status: ${sandbox.status})`,
      );
    }

    log.info({ sandboxId }, "Recovering sandbox from error state");

    // Defensive cleanup — all operations are tolerant of already-gone resources
    if (!isMock()) {
      if (sandbox.runtime.pid) {
        await killProcess(sandbox.runtime.pid);
      }

      await cleanupSandboxFiles(sandboxId);

      const tapDevice = `tap-${sandboxId.slice(0, 8)}`;
      await networkService.deleteTap(tapDevice);
      await proxyService.removeRoutes(sandboxId);
    }

    // Transition to stopped so start() can take over
    this.deps.ports.sandbox.updateStatus(sandboxId, "stopped");
    eventBus.emit({
      type: "sandbox.updated",
      properties: { id: sandboxId, status: "stopped" },
    });
    log.info({ sandboxId }, "Stale resources cleaned up, starting VM");

    // Delegate to start() for the full boot sequence
    return this.start(sandboxId);
  }

  async start(sandboxId: string): Promise<Sandbox> {
    const sandbox = this.deps.ports.sandbox.getById(sandboxId);
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
      this.deps.ports.sandbox.updateStatus(sandboxId, "running");
      eventBus.emit({
        type: "sandbox.updated",
        properties: { id: sandboxId, status: "running" },
      });
      const updated = this.deps.ports.sandbox.getById(sandboxId);
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
    await networkService.createTap(tapDevice);

    const { pid: proc_pid, client } = await launchFirecracker(paths);
    log.debug({ sandboxId, pid: proc_pid }, "Firecracker process started");

    await configureVm(client, {
      paths,
      macAddress,
      tapDevice,
      vcpus: sandbox.runtime.vcpus,
      memoryMb: sandbox.runtime.memoryMb,
      ipAddress: sandbox.runtime.ipAddress,
      gateway: config.network.bridgeIp,
    });
    log.debug({ sandboxId }, "VM configured");

    await client.start();
    await waitForBoot(client);
    log.debug({ sandboxId }, "VM booted");

    const agentReady = await this.deps.ports.agent.waitForAgent(sandboxId, {
      timeout: 60000,
    });

    if (!agentReady) {
      log.warn({ sandboxId }, "Agent did not become ready after restart");
    } else {
      const workspace = sandbox.workspaceId
        ? this.deps.ports.workspaces.getById(sandbox.workspaceId)
        : undefined;
      if (workspace) {
        await provisionWorkspaceRestart(sandboxId, workspace, this.deps.ports);
      } else {
        await provisionSystemRestart(sandboxId, this.deps.ports);
      }
    }

    await proxyService.registerRoutes(sandboxId, sandbox.runtime.ipAddress, {
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

    this.deps.ports.sandbox.update(sandboxId, updatedSandbox);
    eventBus.emit({
      type: "sandbox.updated",
      properties: { id: sandboxId, status: "running" },
    });
    log.info({ sandboxId, pid: proc_pid }, "Sandbox started");

    return updatedSandbox;
  }

  async getStatus(sandboxId: string): Promise<Sandbox | undefined> {
    const sandbox = this.deps.ports.sandbox.getById(sandboxId);
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
      this.deps.ports.sandbox.updateStatus(
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

    // IP self-heal: verify guest has the expected IP
    if (processAlive.exitCode === 0 && vsockExists) {
      await this.healIpIfNeeded(sandboxId, sandbox);
    }

    return this.deps.ports.sandbox.getById(sandboxId) ?? sandbox;
  }

  private setRuntimeError(sandboxId: string, error: string): void {
    const current = this.deps.ports.sandbox.getById(sandboxId);
    if (!current) return;
    this.deps.ports.sandbox.update(sandboxId, {
      runtime: { ...current.runtime, error },
    });
  }

  private clearRuntimeError(sandboxId: string, sandbox?: Sandbox): void {
    const current = sandbox ?? this.deps.ports.sandbox.getById(sandboxId);
    if (!current?.runtime.error) return;
    const { error: _removed, ...cleanRuntime } = current.runtime;
    this.deps.ports.sandbox.update(sandboxId, {
      runtime: cleanRuntime,
    });
    log.info({ sandboxId }, "Cleared stale runtime error");
  }

  /**
   * Verify guest IP matches DB record. If mismatch, attempt to push
   * the correct IP via agent. If push fails, mark sandbox as error.
   */
  private async healIpIfNeeded(
    sandboxId: string,
    sandbox: Sandbox,
  ): Promise<void> {
    const expectedIp = sandbox.runtime.ipAddress;
    if (!expectedIp) return;

    try {
      const result = await this.deps.ports.agent.exec(
        sandboxId,
        "ip -4 addr show dev eth0 | grep -oP 'inet \\K[\\d.]+'",
        { timeout: 3000 },
      );

      if (result.exitCode !== 0) return; // Agent unreachable, skip

      const guestIp = result.stdout.trim();
      if (!guestIp || guestIp === expectedIp) return;

      log.warn(
        { sandboxId, expectedIp, guestIp },
        "IP mismatch detected, attempting auto-fix",
      );

      // Attempt fix: push correct IP
      const fixCmd = [
        "ip -4 addr flush dev eth0",
        `ip addr add ${expectedIp}/${config.network.bridgeNetmask} dev eth0`,
        "ip link set eth0 up",
        `ip route replace default via ${config.network.bridgeIp} dev eth0`,
        "ip -family inet neigh flush any",
      ].join(" && ");

      const fixResult = await this.deps.ports.agent.exec(sandboxId, fixCmd, {
        timeout: 5000,
      });

      if (fixResult.exitCode === 0) {
        log.info({ sandboxId, expectedIp }, "IP mismatch auto-fixed");
      } else {
        log.error(
          {
            sandboxId,
            expectedIp,
            guestIp,
            stderr: fixResult.stderr,
          },
          "IP mismatch auto-fix failed, marking as error",
        );
        this.deps.ports.sandbox.updateStatus(
          sandboxId,
          "error",
          `IP mismatch: expected ${expectedIp}, got ${guestIp}`,
        );
        eventBus.emit({
          type: "sandbox.updated",
          properties: { id: sandboxId, status: "error" },
        });
      }
    } catch {
      // Agent communication failed — don't mark as error for transient issues
      log.debug({ sandboxId }, "IP heal check skipped (agent unreachable)");
    }
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
