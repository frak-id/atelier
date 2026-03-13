import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import { waitForOpencode } from "../../orchestrators/kernel/boot-waiter.ts";
import type { SandboxDestroyer } from "../../orchestrators/sandbox-destroyer.ts";
import type { SandboxSpawner } from "../../orchestrators/sandbox-spawner.ts";
import { config, isMock } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { buildOpenCodeAuthHeaders } from "../../shared/lib/opencode-auth.ts";
import type { InternalService } from "../internal/index.ts";
import type { SandboxRepository } from "../sandbox/index.ts";
import type { SystemSandboxEventListener } from "./system-sandbox-event-listener.ts";

const log = createChildLogger("system-sandbox");

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SYSTEM_SANDBOX_VCPUS = 1;
const SYSTEM_SANDBOX_MEMORY_MB = 1024;
const MAX_LIFETIME_MS = 6 * 60 * 60 * 1000;

export const SYSTEM_WORKSPACE_ID = "__system__";

export type SystemSandboxStatus = "off" | "booting" | "running" | "idle";

interface SystemSandboxDependencies {
  sandboxSpawner: SandboxSpawner;
  sandboxDestroyer: SandboxDestroyer;
  sandboxService: SandboxRepository;
  internalService: InternalService;
  eventListener: SystemSandboxEventListener;
}

export class SystemSandboxService {
  private sandboxId: string | null = null;
  private opencodePassword: string | null = null;
  private activeCount = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private bootPromise: Promise<string> | null = null;
  private maxLifetimeTimer: ReturnType<typeof setTimeout> | null = null;
  private bootedAt: number | null = null;

  constructor(private readonly deps: SystemSandboxDependencies) {}

  /**
   * Reclaim or clean up system sandboxes from a previous manager lifetime.
   * MUST run before any acquire() call — called during startup.
   */
  async recoverFromRestart(): Promise<void> {
    const systemSandboxes = this.deps.sandboxService
      .getAll()
      .filter((s) => s.workspaceId === SYSTEM_WORKSPACE_ID);

    if (systemSandboxes.length === 0) {
      log.info("No system sandboxes found from previous run");
      return;
    }

    // Sort by creation time descending — keep newest, destroy rest
    const sorted = systemSandboxes.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    const candidate = sorted[0];
    const extras = sorted.slice(1);

    // Destroy extras first
    for (const extra of extras) {
      log.info(
        { sandboxId: extra.id },
        "Destroying extra system sandbox from previous run",
      );
      await this.deps.sandboxDestroyer.destroy(extra.id).catch((error) => {
        log.warn(
          { sandboxId: extra.id, error },
          "Failed to destroy extra system sandbox",
        );
      });
    }

    // Try to reclaim the newest one
    if (candidate && candidate.status === "running") {
      try {
        if (!isMock()) {
          await waitForOpencode(
            candidate.runtime.ipAddress,
            candidate.runtime.opencodePassword,
          );
        }
        this.sandboxId = candidate.id;
        this.opencodePassword = candidate.runtime.opencodePassword ?? null;
        this.bootedAt = new Date(candidate.createdAt).getTime();
        await this.registerMcpServer(
          candidate.runtime.ipAddress,
          candidate.runtime.opencodePassword,
        );
        this.deps.eventListener.start(
          candidate.id,
          candidate.runtime.opencodePassword,
        );
        log.info(
          { sandboxId: candidate.id },
          "Reclaimed system sandbox from previous run",
        );
        this.startIdleTimer();
        this.startMaxLifetimeTimer();
      } catch {
        log.warn(
          { sandboxId: candidate.id },
          "System sandbox from previous run not healthy, destroying",
        );
        await this.deps.sandboxDestroyer
          .destroy(candidate.id)
          .catch((error) => {
            log.warn(
              { sandboxId: candidate.id, error },
              "Failed to destroy unhealthy system sandbox",
            );
          });
      }
    } else if (candidate) {
      log.info(
        { sandboxId: candidate.id, status: candidate.status },
        "Destroying non-running system sandbox from previous run",
      );
      await this.deps.sandboxDestroyer.destroy(candidate.id).catch((error) => {
        log.warn(
          { sandboxId: candidate.id, error },
          "Failed to destroy non-running system sandbox",
        );
      });
    }
  }

  async acquire(): Promise<{ client: OpencodeClient; ipAddress: string }> {
    this.clearIdleTimer();

    const ipAddress = await this.ensureSandbox();

    // Increment AFTER ensureSandbox succeeds — if it throws, activeCount
    // stays balanced and the idle timer can still fire.
    this.activeCount++;

    const url = `http://${ipAddress}:${config.ports.opencode}`;
    const client = createOpencodeClient({
      baseUrl: url,
      headers: buildOpenCodeAuthHeaders(this.opencodePassword ?? undefined),
    });

    return { client, ipAddress };
  }

  release(): void {
    this.activeCount = Math.max(0, this.activeCount - 1);

    if (this.activeCount === 0) {
      this.startIdleTimer();
    }
  }

  /**
   * Boot the system sandbox without acquiring a session.
   * The sandbox will enter the idle state and auto-dispose after the
   * idle timeout if no sessions acquire it.
   */
  async ensureRunning(): Promise<void> {
    await this.ensureSandbox();
    this.startIdleTimer();
  }

  async dispose(): Promise<void> {
    this.deps.eventListener.stop();
    this.clearIdleTimer();
    this.clearMaxLifetimeTimer();
    this.bootPromise = null;
    this.bootedAt = null;
    this.opencodePassword = null;

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

  /**
   * Detect and reset zombie state where in-memory sandboxId points to a
   * sandbox that no longer exists in the DB or whose process has died.
   * Called from the self-heal cron.
   */
  healIfNeeded(): void {
    if (!this.sandboxId || this.bootPromise) return;

    const sandbox = this.deps.sandboxService.getById(this.sandboxId);

    if (!sandbox || sandbox.status !== "running") {
      log.warn(
        {
          sandboxId: this.sandboxId,
          found: !!sandbox,
          status: sandbox?.status,
        },
        "System sandbox zombie detected, resetting state",
      );
      this.clearIdleTimer();
      this.deps.eventListener.stop();
      this.sandboxId = null;
      this.opencodePassword = null;
      this.bootedAt = null;
      this.activeCount = 0;
      return;
    }

    this.deps.eventListener.healIfNeeded(
      this.sandboxId,
      this.opencodePassword ?? undefined,
    );
  }

  getSandboxId(): string | null {
    return this.sandboxId;
  }

  getStatus(): {
    status: SystemSandboxStatus;
    sandboxId: string | null;
    activeCount: number;
    uptimeMs: number | null;
    opencodeUrl: string | null;
  } {
    let status: SystemSandboxStatus = "off";

    if (this.bootPromise) {
      status = "booting";
    } else if (this.sandboxId) {
      status = this.activeCount > 0 ? "running" : "idle";
    }

    const sandbox = this.sandboxId
      ? this.deps.sandboxService.getById(this.sandboxId)
      : undefined;

    return {
      status,
      sandboxId: this.sandboxId,
      activeCount: this.activeCount,
      uptimeMs: this.bootedAt ? Date.now() - this.bootedAt : null,
      opencodeUrl: sandbox?.runtime?.urls?.opencode || null,
    };
  }

  private async ensureSandbox(): Promise<string> {
    if (this.sandboxId) {
      const sandbox = this.deps.sandboxService.getById(this.sandboxId);
      if (sandbox?.status === "running" && sandbox.runtime?.ipAddress) {
        this.opencodePassword = sandbox.runtime.opencodePassword ?? null;
        return sandbox.runtime.ipAddress;
      }
      log.warn(
        { sandboxId: this.sandboxId },
        "System sandbox no longer running, recreating",
      );
      // Destroy the stale sandbox to prevent resource leaks
      const staleId = this.sandboxId;
      this.sandboxId = null;
      this.opencodePassword = null;
      this.bootedAt = null;
      await this.deps.sandboxDestroyer.destroy(staleId).catch((error) => {
        log.warn(
          { sandboxId: staleId, error },
          "Failed to destroy stale system sandbox",
        );
      });
    }

    if (this.bootPromise) {
      return this.bootPromise;
    }

    this.bootPromise = this.boot();

    try {
      return await this.bootPromise;
    } catch (error) {
      // Clear sandboxId on boot failure to avoid stale state
      this.sandboxId = null;
      this.opencodePassword = null;
      this.bootedAt = null;
      throw error;
    } finally {
      this.bootPromise = null;
    }
  }

  private async boot(): Promise<string> {
    log.info("Booting system sandbox");
    const startTime = performance.now();

    const sandbox = await this.deps.sandboxSpawner.spawn({
      workspaceId: SYSTEM_WORKSPACE_ID,
      system: true,
      vcpus: SYSTEM_SANDBOX_VCPUS,
      memoryMb: SYSTEM_SANDBOX_MEMORY_MB,
    });

    this.sandboxId = sandbox.id;
    this.opencodePassword = sandbox.runtime.opencodePassword ?? null;
    this.bootedAt = Date.now();
    const ipAddress = sandbox.runtime.ipAddress;

    log.info(
      {
        sandboxId: sandbox.id,
        ipAddress,
        bootMs: Math.round(performance.now() - startTime),
      },
      "System sandbox booted",
    );

    if (!isMock()) {
      await waitForOpencode(ipAddress, sandbox.runtime.opencodePassword);
    }
    await this.registerMcpServer(ipAddress, sandbox.runtime.opencodePassword);
    this.deps.eventListener.start(sandbox.id, sandbox.runtime.opencodePassword);
    this.startMaxLifetimeTimer();

    return ipAddress;
  }

  private async registerMcpServer(
    ipAddress: string,
    password?: string,
  ): Promise<void> {
    const mcpToken = config.server.mcpToken;
    const mcpUrl = `${config.kubernetes.managerUrl}/mcp`;

    const url = `http://${ipAddress}:${config.ports.opencode}`;
    const client = createOpencodeClient({
      baseUrl: url,
      headers: buildOpenCodeAuthHeaders(password),
    });

    try {
      await client.mcp.add({
        name: "atelier-manager",
        config: {
          type: "remote" as const,
          url: mcpUrl,
          enabled: true,
          ...(mcpToken && {
            headers: { Authorization: `Bearer ${mcpToken}` },
          }),
          oauth: false,
          timeout: 10000,
        },
      });
      log.info({ ipAddress }, "MCP server registered with system sandbox");
    } catch (error) {
      log.warn(
        { error, ipAddress },
        "Failed to register MCP server with system sandbox",
      );
    }
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

  private startMaxLifetimeTimer(): void {
    this.clearMaxLifetimeTimer();
    this.maxLifetimeTimer = setTimeout(() => {
      log.info(
        { sandboxId: this.sandboxId, activeCount: this.activeCount },
        "System sandbox max lifetime reached, recycling",
      );
      this.dispose().catch((error) => {
        log.error(
          { error },
          "Failed to dispose system sandbox on max lifetime",
        );
      });
    }, MAX_LIFETIME_MS);
  }

  private clearMaxLifetimeTimer(): void {
    if (this.maxLifetimeTimer) {
      clearTimeout(this.maxLifetimeTimer);
      this.maxLifetimeTimer = null;
    }
  }
}
