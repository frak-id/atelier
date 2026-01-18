import { $ } from "bun";
import { Elysia } from "elysia";
import { config } from "../../lib/config.ts";
import { createChildLogger } from "../../lib/logger.ts";
import {
  type CleanupResult,
  CleanupResultSchema,
  QueueStatusSchema,
  StorageStatusSchema,
  type SystemStats,
  SystemStatsSchema,
} from "../../schemas/index.ts";
import { QueueService } from "../../services/queue.ts";
import { StorageService } from "../../services/storage.ts";
import { sandboxStore } from "../../state/store.ts";

const log = createChildLogger("system-route");
const startTime = Date.now();

async function getSystemStats(): Promise<SystemStats> {
  if (config.isMock()) {
    return {
      cpuUsage: 25,
      memoryUsed: 4 * 1024 * 1024 * 1024,
      memoryTotal: 16 * 1024 * 1024 * 1024,
      memoryPercent: 25,
      diskUsed: 50 * 1024 * 1024 * 1024,
      diskTotal: 500 * 1024 * 1024 * 1024,
      diskPercent: 10,
      activeSandboxes: sandboxStore.countByStatus("running"),
      maxSandboxes: config.defaults.MAX_SANDBOXES,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    };
  }

  const [cpuResult, memResult, diskResult] = await Promise.all([
    $`top -bn1 | grep "Cpu(s)" | awk '{print $2}' | cut -d'%' -f1`
      .quiet()
      .nothrow(),
    $`free -b | grep Mem`.quiet().nothrow(),
    $`df -B1 / | tail -1`.quiet().nothrow(),
  ]);

  const cpuUsage = Number.parseFloat(cpuResult.stdout.toString().trim()) || 0;

  const memParts = memResult.stdout.toString().trim().split(/\s+/);
  const memoryTotal = Number.parseInt(memParts[1] || "0", 10);
  const memoryUsed = Number.parseInt(memParts[2] || "0", 10);

  const diskParts = diskResult.stdout.toString().trim().split(/\s+/);
  const diskTotal = Number.parseInt(diskParts[1] || "0", 10);
  const diskUsed = Number.parseInt(diskParts[2] || "0", 10);

  return {
    cpuUsage,
    memoryUsed,
    memoryTotal,
    memoryPercent: memoryTotal > 0 ? (memoryUsed / memoryTotal) * 100 : 0,
    diskUsed,
    diskTotal,
    diskPercent: diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0,
    activeSandboxes: sandboxStore.countByStatus("running"),
    maxSandboxes: config.defaults.MAX_SANDBOXES,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
}

async function performCleanup(): Promise<CleanupResult> {
  log.info("Starting system cleanup");

  let socketsRemoved = 0;
  let overlaysRemoved = 0;
  let tapDevicesRemoved = 0;
  const spaceFreed = 0;

  if (!config.isMock()) {
    const socketResult =
      await $`find ${config.paths.SANDBOX_DIR} -name "*.socket" -type s 2>/dev/null | wc -l`
        .quiet()
        .nothrow();
    socketsRemoved = Number.parseInt(
      socketResult.stdout.toString().trim() || "0",
      10,
    );

    if (socketsRemoved > 0) {
      await $`find ${config.paths.SANDBOX_DIR} -name "*.socket" -type s -delete 2>/dev/null`
        .quiet()
        .nothrow();
    }

    const overlayResult =
      await $`find ${config.paths.SANDBOX_DIR} -type d -name "overlay-*" 2>/dev/null | wc -l`
        .quiet()
        .nothrow();
    overlaysRemoved = Number.parseInt(
      overlayResult.stdout.toString().trim() || "0",
      10,
    );

    const tapResult =
      await $`ip link show | grep -c "tap-sandbox" 2>/dev/null || echo 0`
        .quiet()
        .nothrow();
    tapDevicesRemoved = Number.parseInt(
      tapResult.stdout.toString().trim() || "0",
      10,
    );
  }

  const ONE_HOUR_MS = 3600000;
  const jobsRemoved = QueueService.cleanup(ONE_HOUR_MS);

  log.info(
    { socketsRemoved, overlaysRemoved, tapDevicesRemoved, jobsRemoved },
    "Cleanup completed",
  );

  return {
    socketsRemoved,
    overlaysRemoved,
    tapDevicesRemoved,
    spaceFreed,
  };
}

export const systemRoutes = new Elysia({ prefix: "/system" })
  .get(
    "/stats",
    async () => {
      return getSystemStats();
    },
    {
      response: SystemStatsSchema,
      detail: { tags: ["system"] },
    },
  )
  .get(
    "/storage",
    async () => {
      const [available, hasBaseVolume, pool] = await Promise.all([
        StorageService.isAvailable(),
        StorageService.hasBaseVolume(),
        StorageService.getPoolStats(),
      ]);

      return {
        available,
        hasBaseVolume,
        pool,
      };
    },
    {
      response: StorageStatusSchema,
      detail: { tags: ["system"] },
    },
  )
  .get(
    "/queue",
    () => {
      const stats = QueueService.getStats();
      const queued = QueueService.getQueuedJobs().map((j) => ({
        id: j.id,
        workspaceId: j.options.workspaceId,
        queuedAt: j.queuedAt,
      }));
      const running = QueueService.getRunningJobs().map((j) => ({
        id: j.id,
        workspaceId: j.options.workspaceId,
        startedAt: j.startedAt,
      }));

      return { stats, queued, running };
    },
    {
      response: QueueStatusSchema,
      detail: { tags: ["system"] },
    },
  )
  .post(
    "/cleanup",
    async () => {
      return performCleanup();
    },
    {
      response: CleanupResultSchema,
      detail: { tags: ["system"] },
    },
  );
