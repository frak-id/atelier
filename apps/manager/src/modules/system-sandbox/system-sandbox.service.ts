import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import type { SandboxDestroyer } from "../../orchestrators/sandbox-destroyer.ts";
import type { SandboxSpawner } from "../../orchestrators/sandbox-spawner.ts";
import { config, isMock } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { InternalService } from "../internal/index.ts";
import type { SandboxRepository } from "../sandbox/index.ts";

const log = createChildLogger("system-sandbox");

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const OPENCODE_HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_POLL_INTERVAL_MS = 2000;
const SYSTEM_SANDBOX_VCPUS = 1;
const SYSTEM_SANDBOX_MEMORY_MB = 1024;

interface SystemSandboxDependencies {
  sandboxSpawner: SandboxSpawner;
  sandboxDestroyer: SandboxDestroyer;
  sandboxService: SandboxRepository;
  internalService: InternalService;
}

export class SystemSandboxService {
  private sandboxId: string | null = null;
  private activeCount = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private bootPromise: Promise<string> | null = null;

  constructor(private readonly deps: SystemSandboxDependencies) {}

  async acquire(): Promise<{ client: OpencodeClient; ipAddress: string }> {
    this.activeCount++;
    this.clearIdleTimer();

    const ipAddress = await this.ensureSandbox();
    const url = `http://${ipAddress}:${config.advanced.vm.opencode.port}`;
    const client = createOpencodeClient({ baseUrl: url });

    return { client, ipAddress };
  }

  release(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);

    if (this.activeCount === 0) {
      this.startIdleTimer();
    }
  }

  async dispose(): Promise<void> {
    this.clearIdleTimer();
    this.bootPromise = null;

    if (this.sandboxId) {
      const id = this.sandboxId;
      this.sandboxId = null;
      try {
        await this.deps.sandboxDestroyer.destroy(id);
        log.info({ sandboxId: id }, "System sandbox destroyed");
      } catch (error) {
        log.warn({ sandboxId: id, error }, "Failed to destroy system sandbox");
      }
    }
  }

  getSandboxId(): string | null {
    return this.sandboxId;
  }

  private async ensureSandbox(): Promise<string> {
    if (this.sandboxId) {
      const sandbox = this.deps.sandboxService.getById(this.sandboxId);
      if (sandbox?.status === "running" && sandbox.runtime?.ipAddress) {
        return sandbox.runtime.ipAddress;
      }
      log.warn(
        { sandboxId: this.sandboxId },
        "System sandbox no longer running, recreating",
      );
      this.sandboxId = null;
    }

    if (this.bootPromise) {
      return this.bootPromise;
    }

    this.bootPromise = this.boot();

    try {
      return await this.bootPromise;
    } finally {
      this.bootPromise = null;
    }
  }

  private async boot(): Promise<string> {
    log.info("Booting system sandbox");
    const startTime = performance.now();

    const sandbox = await this.deps.sandboxSpawner.spawn({
      vcpus: SYSTEM_SANDBOX_VCPUS,
      memoryMb: SYSTEM_SANDBOX_MEMORY_MB,
    });

    this.sandboxId = sandbox.id;
    const ipAddress = sandbox.runtime.ipAddress;

    log.info(
      {
        sandboxId: sandbox.id,
        ipAddress,
        bootMs: Math.round(performance.now() - startTime),
      },
      "System sandbox booted",
    );

    await this.waitForOpencode(ipAddress);

    return ipAddress;
  }

  private async waitForOpencode(ipAddress: string): Promise<void> {
    if (isMock()) return;

    const startTime = Date.now();
    const url = `http://${ipAddress}:${config.advanced.vm.opencode.port}`;

    while (Date.now() - startTime < OPENCODE_HEALTH_TIMEOUT_MS) {
      try {
        const client = createOpencodeClient({ baseUrl: url });
        const { data } = await client.global.health();
        if (data?.healthy) {
          log.info({ ipAddress }, "System sandbox opencode is healthy");
          return;
        }
      } catch {}
      await Bun.sleep(HEALTH_POLL_INTERVAL_MS);
    }

    throw new Error(
      "System sandbox opencode did not become healthy within timeout",
    );
  }

  private startIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      log.info(
        { sandboxId: this.sandboxId },
        "System sandbox idle timeout, destroying",
      );
      this.dispose().catch((error) => {
        log.error({ error }, "Failed to dispose system sandbox on idle");
      });
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
