import { $ } from "bun";
import { Elysia } from "elysia";
import { sandboxService } from "../container.ts";
import { NetworkService } from "../infrastructure/network/index.ts";
import {
  CaddyService,
  SshPiperService,
} from "../infrastructure/proxy/index.ts";
import { QueueService } from "../infrastructure/queue/index.ts";
import { StorageService } from "../infrastructure/storage/index.ts";
import {
  type CleanupResult,
  CleanupResultSchema,
  QueueStatusSchema,
  StorageStatusSchema,
  type SystemStats,
  SystemStatsSchema,
} from "../schemas/index.ts";
import { config } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("system-routes");
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
      activeSandboxes: sandboxService.countByStatus("running"),
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
    activeSandboxes: sandboxService.countByStatus("running"),
    maxSandboxes: config.defaults.MAX_SANDBOXES,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
}

async function performCleanup(): Promise<CleanupResult> {
  log.info("Starting system cleanup");

  let socketsRemoved = 0;
  let overlaysRemoved = 0;
  let tapDevicesRemoved = 0;
  let lvmVolumesRemoved = 0;
  let logsRemoved = 0;
  let caddyRoutesRemoved = 0;
  let sshRoutesRemoved = 0;
  const spaceFreed = 0;

  if (!config.isMock()) {
    const knownSandboxIds = new Set(sandboxService.getAll().map((s) => s.id));

    const orphanSocketResult =
      await $`find ${config.paths.SOCKET_DIR} -maxdepth 1 \( -name "*.sock" -o -name "*.vsock" -o -name "*.pid" \) 2>/dev/null`
        .quiet()
        .nothrow();
    const socketFiles = orphanSocketResult.stdout
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const file of socketFiles) {
      const basename = file.split("/").pop() || "";
      const sandboxId = basename.replace(/\.(sock|vsock|pid)$/, "");
      if (!knownSandboxIds.has(sandboxId)) {
        await $`rm -f ${file}`.quiet().nothrow();
        socketsRemoved++;
      }
    }

    const orphanLogResult =
      await $`find ${config.paths.LOG_DIR} -maxdepth 1 -name "*.log" 2>/dev/null`
        .quiet()
        .nothrow();
    const logFiles = orphanLogResult.stdout
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const file of logFiles) {
      const basename = file.split("/").pop() || "";
      const sandboxId = basename.replace(/\.log$/, "");
      if (!knownSandboxIds.has(sandboxId)) {
        await $`rm -f ${file}`.quiet().nothrow();
        logsRemoved++;
      }
    }

    const overlayResult =
      await $`find ${config.paths.SANDBOX_DIR} -type d -name "overlay-*" 2>/dev/null | wc -l`
        .quiet()
        .nothrow();
    overlaysRemoved = Number.parseInt(
      overlayResult.stdout.toString().trim() || "0",
      10,
    );

    const tapDevices = await NetworkService.listTapDevices();
    for (const tap of tapDevices) {
      const sandboxId = tap.replace("tap-", "");
      const matchingSandbox = sandboxService
        .getAll()
        .find((s) => s.id.startsWith(sandboxId));
      if (!matchingSandbox) {
        await NetworkService.deleteTap(tap);
        tapDevicesRemoved++;
      }
    }

    if (await StorageService.isAvailable()) {
      const lvmVolumes = await StorageService.listSandboxVolumes();
      for (const vol of lvmVolumes) {
        if (!knownSandboxIds.has(vol.name)) {
          log.info({ volumeName: vol.name }, "Removing orphaned LVM volume");
          await StorageService.deleteSandboxVolume(vol.name);
          lvmVolumesRemoved++;
        }
      }
    }

    const routes = await CaddyService.getRoutes();
    for (const route of routes) {
      const r = route as { "@id"?: string };
      const id = r["@id"];
      if (!id || id === "wildcard-fallback") continue;

      const sandboxIdMatch = [...knownSandboxIds].find((sid: string) =>
        id.endsWith(`${sid}.${config.caddy.domainSuffix}`),
      );
      if (!sandboxIdMatch) {
        const domain = id;
        if (domain.endsWith(`.${config.caddy.domainSuffix}`)) {
          await CaddyService.removeRoute(domain);
          caddyRoutesRemoved++;
        }
      }
    }

    const sshSandboxIds = await SshPiperService.listRouteSandboxIds();
    for (const sshId of sshSandboxIds) {
      if (!knownSandboxIds.has(sshId)) {
        await SshPiperService.removeRoute(sshId);
        sshRoutesRemoved++;
      }
    }
  }

  const ONE_HOUR_MS = 3600000;
  const jobsRemoved = QueueService.cleanup(ONE_HOUR_MS);

  log.info(
    {
      socketsRemoved,
      overlaysRemoved,
      tapDevicesRemoved,
      lvmVolumesRemoved,
      logsRemoved,
      caddyRoutesRemoved,
      sshRoutesRemoved,
      jobsRemoved,
    },
    "Cleanup completed",
  );

  return {
    socketsRemoved,
    overlaysRemoved,
    tapDevicesRemoved,
    lvmVolumesRemoved,
    logsRemoved,
    caddyRoutesRemoved,
    sshRoutesRemoved,
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
      const [available, hasDefaultImage, pool] = await Promise.all([
        StorageService.isAvailable(),
        StorageService.hasImageVolume("dev-base"),
        StorageService.getPoolStats(),
      ]);

      return {
        available,
        hasDefaultImage,
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
