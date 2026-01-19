import { $ } from "bun";
import {
  FirecrackerClient,
  getSocketPath,
} from "../infrastructure/firecracker/index.ts";
import type { SandboxService } from "../modules/sandbox/index.ts";
import type { Sandbox } from "../schemas/index.ts";
import { NotFoundError } from "../shared/errors.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { fileExists } from "../shared/lib/shell.ts";

const log = createChildLogger("sandbox-lifecycle");

interface SandboxLifecycleDependencies {
  sandboxService: SandboxService;
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
      const socketPath = getSocketPath(sandboxId);
      if (!(await fileExists(socketPath))) {
        throw new Error(`Socket not found for sandbox '${sandboxId}'`);
      }

      const client = new FirecrackerClient(socketPath);
      await client.pause();
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

    if (!config.isMock()) {
      const socketPath = getSocketPath(sandboxId);
      if (!(await fileExists(socketPath))) {
        throw new Error(
          `Socket not found for sandbox '${sandboxId}' - VM may have crashed`,
        );
      }

      const processAlive = sandbox.runtime.pid
        ? await $`kill -0 ${sandbox.runtime.pid}`.quiet().nothrow()
        : { exitCode: 1 };

      if (processAlive.exitCode !== 0) {
        throw new Error(
          `Sandbox '${sandboxId}' process is not running - cannot resume`,
        );
      }

      const client = new FirecrackerClient(socketPath);
      await client.resume();
    }

    this.deps.sandboxService.updateStatus(sandboxId, "running");
    log.info({ sandboxId }, "Sandbox started");

    const updated = this.deps.sandboxService.getById(sandboxId);
    if (!updated) {
      throw new Error(`Sandbox not found after start: ${sandboxId}`);
    }
    return updated;
  }

  async getStatus(sandboxId: string): Promise<Sandbox | undefined> {
    const sandbox = this.deps.sandboxService.getById(sandboxId);
    if (!sandbox) {
      return undefined;
    }

    if (config.isMock() || !sandbox.runtime.pid) {
      return sandbox;
    }

    const socketPath = getSocketPath(sandboxId);
    const processAlive = await $`kill -0 ${sandbox.runtime.pid}`
      .quiet()
      .nothrow();
    const socketExists = await fileExists(socketPath);

    if (processAlive.exitCode !== 0 || !socketExists) {
      if (sandbox.status !== "stopped") {
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
    }

    return this.deps.sandboxService.getById(sandboxId) ?? sandbox;
  }

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
  }
}
