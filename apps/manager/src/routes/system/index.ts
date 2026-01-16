import { Elysia, t } from "elysia";
import { SystemService } from "./service.ts";
import { StorageService } from "../../services/storage.ts";
import { QueueService } from "../../services/queue.ts";

export const systemRoutes = new Elysia({ prefix: "/system" })
  .get(
    "/stats",
    async () => {
      return SystemService.getStats();
    },
    {
      response: t.Object({
        cpuUsage: t.Number(),
        memoryUsed: t.Number(),
        memoryTotal: t.Number(),
        memoryPercent: t.Number(),
        diskUsed: t.Number(),
        diskTotal: t.Number(),
        diskPercent: t.Number(),
        activeSandboxes: t.Number(),
        maxSandboxes: t.Number(),
        uptime: t.Number(),
      }),
    },
  )
  .get(
    "/storage",
    async () => {
      const [poolStats, available, hasBase] = await Promise.all([
        StorageService.getPoolStats(),
        StorageService.isAvailable(),
        StorageService.hasBaseVolume(),
      ]);

      return {
        available,
        hasBaseVolume: hasBase,
        pool: poolStats,
      };
    },
    {
      response: t.Object({
        available: t.Boolean(),
        hasBaseVolume: t.Boolean(),
        pool: t.Object({
          exists: t.Boolean(),
          dataPercent: t.Number(),
          metadataPercent: t.Number(),
          totalSize: t.String(),
          usedSize: t.String(),
          volumeCount: t.Number(),
        }),
      }),
    },
  )
  .get(
    "/queue",
    () => {
      const stats = QueueService.getStats();
      const queuedJobs = QueueService.getQueuedJobs();
      const runningJobs = QueueService.getRunningJobs();

      return {
        stats,
        queued: queuedJobs.map((j) => ({
          id: j.id,
          projectId: j.options.projectId,
          queuedAt: j.queuedAt,
        })),
        running: runningJobs.map((j) => ({
          id: j.id,
          projectId: j.options.projectId,
          startedAt: j.startedAt,
        })),
      };
    },
    {
      response: t.Object({
        stats: t.Object({
          queued: t.Number(),
          running: t.Number(),
          completed: t.Number(),
          failed: t.Number(),
          maxConcurrent: t.Number(),
        }),
        queued: t.Array(
          t.Object({
            id: t.String(),
            projectId: t.Optional(t.String()),
            queuedAt: t.String(),
          }),
        ),
        running: t.Array(
          t.Object({
            id: t.String(),
            projectId: t.Optional(t.String()),
            startedAt: t.Optional(t.String()),
          }),
        ),
      }),
    },
  )
  .post(
    "/cleanup",
    async () => {
      const systemCleanup = await SystemService.cleanup();
      const queueCleanup = QueueService.cleanup();

      return {
        ...systemCleanup,
        jobsRemoved: queueCleanup,
      };
    },
    {
      response: t.Object({
        socketsRemoved: t.Number(),
        overlaysRemoved: t.Number(),
        tapDevicesRemoved: t.Number(),
        spaceFreed: t.Number(),
        jobsRemoved: t.Number(),
      }),
    },
  );
