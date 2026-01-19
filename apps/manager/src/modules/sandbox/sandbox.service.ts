import { FIRECRACKER } from "@frak-sandbox/shared/constants";
import { $ } from "bun";
import type { AgentClient } from "../../infrastructure/agent/index.ts";
import {
  FirecrackerClient,
  getSocketPath,
} from "../../infrastructure/firecracker/index.ts";
import { NetworkService } from "../../infrastructure/network/index.ts";
import { CaddyService } from "../../infrastructure/proxy/index.ts";
import { QueueService } from "../../infrastructure/queue/index.ts";
import { StorageService } from "../../infrastructure/storage/index.ts";
import type {
  CreateSandboxBody,
  Sandbox,
  Workspace,
} from "../../schemas/index.ts";
import { NotFoundError } from "../../shared/errors.ts";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { fileExists } from "../../shared/lib/shell.ts";
import { SandboxBuilder } from "./sandbox.builder.ts";
import type { SandboxRepository } from "./sandbox.repository.ts";

const log = createChildLogger("sandbox-service");

let lvmAvailable: boolean | null = null;

type GitSourceGetter = (
  id: string,
) => { type: string; config: unknown } | undefined;
type ConfigFilesGetter = (workspaceId?: string) => {
  path: string;
  content: string;
  contentType: "json" | "text" | "binary";
}[];
type WorkspaceGetter = (id: string) => Workspace | undefined;

interface SandboxServiceDependencies {
  getWorkspace: WorkspaceGetter;
  getGitSource: GitSourceGetter;
  getConfigFiles: ConfigFilesGetter;
  agentClient: AgentClient;
}

export class SandboxService {
  constructor(
    private readonly sandboxRepository: SandboxRepository,
    private readonly deps: SandboxServiceDependencies,
  ) {
    QueueService.setHandler((options) => this.spawn(options));
  }

  async spawn(options: CreateSandboxBody = {}): Promise<Sandbox> {
    return SandboxBuilder.create(
      this.sandboxRepository,
      options,
      this.deps,
    ).build();
  }

  async destroy(sandboxId: string): Promise<void> {
    const sandbox = this.sandboxRepository.getById(sandboxId);
    if (!sandbox) {
      throw new NotFoundError("Sandbox", sandboxId);
    }

    log.info({ sandboxId }, "Destroying sandbox");

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

      NetworkService.release(sandbox.runtime.ipAddress);
      await CaddyService.removeRoutes(sandboxId);
    }

    this.sandboxRepository.delete(sandboxId);
    log.info({ sandboxId }, "Sandbox destroyed");
  }

  async getStatus(sandboxId: string): Promise<Sandbox | undefined> {
    const sandbox = this.sandboxRepository.getById(sandboxId);
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
        this.sandboxRepository.updateStatus(sandboxId, "error");
      }
    }

    return this.sandboxRepository.getById(sandboxId) ?? sandbox;
  }

  async stop(sandboxId: string): Promise<Sandbox> {
    const sandbox = this.sandboxRepository.getById(sandboxId);
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

    this.sandboxRepository.updateStatus(sandboxId, "stopped");
    log.info({ sandboxId }, "Sandbox stopped");

    const updated = this.sandboxRepository.getById(sandboxId);
    if (!updated) {
      throw new Error(`Sandbox not found after stop: ${sandboxId}`);
    }
    return updated;
  }

  async start(sandboxId: string): Promise<Sandbox> {
    const sandbox = this.sandboxRepository.getById(sandboxId);
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

    this.sandboxRepository.updateStatus(sandboxId, "running");
    log.info({ sandboxId }, "Sandbox started");

    const updated = this.sandboxRepository.getById(sandboxId);
    if (!updated) {
      throw new Error(`Sandbox not found after start: ${sandboxId}`);
    }
    return updated;
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
  }

  isLvmEnabled(): boolean {
    return lvmAvailable === true;
  }

  async checkLvmAvailability(): Promise<boolean> {
    lvmAvailable = await StorageService.isAvailable();
    return lvmAvailable;
  }

  getAll(): Sandbox[] {
    return this.sandboxRepository.getAll();
  }

  getById(id: string): Sandbox | undefined {
    return this.sandboxRepository.getById(id);
  }

  getByStatus(status: "creating" | "running" | "stopped" | "error"): Sandbox[] {
    return this.sandboxRepository.getByStatus(status);
  }

  getByWorkspaceId(workspaceId: string): Sandbox[] {
    return this.sandboxRepository.getByWorkspaceId(workspaceId);
  }

  count(): number {
    return this.sandboxRepository.count();
  }

  countByStatus(status: "creating" | "running" | "stopped" | "error"): number {
    return this.sandboxRepository.countByStatus(status);
  }
}
