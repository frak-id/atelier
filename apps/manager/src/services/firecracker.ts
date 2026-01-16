import { FIRECRACKER } from "@frak-sandbox/shared/constants";
import type { CreateSandboxOptions, Sandbox } from "@frak-sandbox/shared/types";
import { $ } from "bun";
import { config } from "../lib/config.ts";
import { NotFoundError } from "../lib/errors.ts";
import { createChildLogger } from "../lib/logger.ts";
import { fileExists } from "../lib/shell.ts";
import { SandboxRepository } from "../state/database.ts";
import { CaddyService } from "./caddy.ts";
import { FirecrackerClient } from "./firecracker-client.ts";
import { NetworkService } from "./network.ts";
import { QueueService } from "./queue.ts";
import { SandboxBuilder } from "./sandbox-builder.ts";
import { StorageService } from "./storage.ts";

const log = createChildLogger("firecracker");

let lvmAvailable: boolean | null = null;

function getSocketPath(sandboxId: string): string {
  return `${config.paths.SOCKET_DIR}/${sandboxId}.sock`;
}

export const FirecrackerService = {
  async spawn(options: CreateSandboxOptions = {}): Promise<Sandbox> {
    return SandboxBuilder.create(options).build();
  },

  async destroy(sandboxId: string): Promise<void> {
    const sandbox = SandboxRepository.getById(sandboxId);
    if (!sandbox) {
      throw new NotFoundError("Sandbox", sandboxId);
    }

    log.info({ sandboxId }, "Destroying sandbox");

    if (!config.isMock()) {
      if (sandbox.pid) {
        await $`kill ${sandbox.pid} 2>/dev/null || true`.quiet().nothrow();
        await Bun.sleep(500);
        await $`kill -9 ${sandbox.pid} 2>/dev/null || true`.quiet().nothrow();
      }

      const socketPath = getSocketPath(sandboxId);
      const pidPath = `${config.paths.SOCKET_DIR}/${sandboxId}.pid`;
      await $`rm -f ${socketPath} ${pidPath}`.quiet().nothrow();

      if (lvmAvailable ?? (await StorageService.isAvailable())) {
        await StorageService.deleteSandboxVolume(sandboxId);
      } else {
        const overlayPath = `${config.paths.OVERLAY_DIR}/${sandboxId}.ext4`;
        await $`rm -f ${overlayPath}`.quiet().nothrow();
      }

      const tapDevice = `tap-${sandboxId.slice(0, 8)}`;
      await NetworkService.deleteTap(tapDevice);

      NetworkService.release(sandbox.ipAddress);
      await CaddyService.removeRoutes(sandboxId);
    }

    SandboxRepository.delete(sandboxId);
    log.info({ sandboxId }, "Sandbox destroyed");
  },

  async getStatus(sandboxId: string): Promise<Sandbox | undefined> {
    const sandbox = SandboxRepository.getById(sandboxId);
    if (!sandbox) {
      return undefined;
    }

    if (config.isMock() || !sandbox.pid) {
      return sandbox;
    }

    const socketPath = getSocketPath(sandboxId);
    const processAlive = await $`kill -0 ${sandbox.pid}`.quiet().nothrow();
    const socketExists = await fileExists(socketPath);

    if (processAlive.exitCode !== 0 || !socketExists) {
      if (sandbox.status !== "stopped") {
        log.warn(
          {
            sandboxId,
            pid: sandbox.pid,
            processAlive: processAlive.exitCode === 0,
            socketPath,
            socketExists,
          },
          "Sandbox liveness check failed, marking as error",
        );
        SandboxRepository.updateStatus(sandboxId, "error");
      }
    }

    return SandboxRepository.getById(sandboxId) ?? sandbox;
  },

  async stop(sandboxId: string): Promise<Sandbox> {
    const sandbox = SandboxRepository.getById(sandboxId);
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
      const socketPath = getSocketPath(sandboxId);
      if (!(await fileExists(socketPath))) {
        throw new Error(`Socket not found for sandbox '${sandboxId}'`);
      }

      const client = new FirecrackerClient(socketPath);
      await client.pause();
    }

    SandboxRepository.updateStatus(sandboxId, "stopped");
    log.info({ sandboxId }, "Sandbox stopped");

    return SandboxRepository.getById(sandboxId)!;
  },

  async start(sandboxId: string): Promise<Sandbox> {
    const sandbox = SandboxRepository.getById(sandboxId);
    if (!sandbox) {
      throw new NotFoundError("Sandbox", sandboxId);
    }

    if (sandbox.status !== "stopped") {
      throw new Error(
        `Sandbox '${sandboxId}' is not stopped (status: ${sandbox.status})`,
      );
    }

    log.info({ sandboxId }, "Starting sandbox");

    if (!config.isMock()) {
      const socketPath = getSocketPath(sandboxId);
      if (!(await fileExists(socketPath))) {
        throw new Error(
          `Socket not found for sandbox '${sandboxId}' - VM may have crashed`,
        );
      }

      const processAlive = sandbox.pid
        ? await $`kill -0 ${sandbox.pid}`.quiet().nothrow()
        : { exitCode: 1 };

      if (processAlive.exitCode !== 0) {
        throw new Error(
          `Sandbox '${sandboxId}' process is not running - cannot resume`,
        );
      }

      const client = new FirecrackerClient(socketPath);
      await client.resume();
    }

    SandboxRepository.updateStatus(sandboxId, "running");
    log.info({ sandboxId }, "Sandbox started");

    return SandboxRepository.getById(sandboxId)!;
  },

  async getFirecrackerState(sandboxId: string): Promise<unknown> {
    if (config.isMock()) {
      return { mock: true, sandboxId };
    }

    const socketPath = getSocketPath(sandboxId);
    if (!(await fileExists(socketPath))) {
      return { error: "Socket not found", sandboxId };
    }

    try {
      const client = new FirecrackerClient(socketPath);
      return await client.getState();
    } catch {
      return { error: "Failed to query Firecracker", sandboxId };
    }
  },

  async isHealthy(): Promise<boolean> {
    if (config.isMock()) {
      return true;
    }

    const exists = await fileExists(FIRECRACKER.BINARY_PATH);
    if (!exists) return false;

    const kvmOk = await $`test -r /dev/kvm && test -w /dev/kvm`
      .quiet()
      .nothrow();
    return kvmOk.exitCode === 0;
  },

  isLvmEnabled(): boolean {
    return lvmAvailable === true;
  },

  async checkLvmAvailability(): Promise<boolean> {
    lvmAvailable = await StorageService.isAvailable();
    return lvmAvailable;
  },
};

QueueService.setHandler((options) => FirecrackerService.spawn(options));
