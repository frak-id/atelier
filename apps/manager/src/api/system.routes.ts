import { $ } from "bun";
import { Elysia } from "elysia";
import {
  prebuildRunner,
  sandboxService,
  systemSandboxService,
} from "../container.ts";
import { SYSTEM_WORKSPACE_ID } from "../modules/system-sandbox/index.ts";
import {
  type CleanupResult,
  CleanupResultSchema,
  SystemSandboxStatusSchema,
  type SystemStats,
  SystemStatsSchema,
} from "../schemas/index.ts";
import { config, isMock } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("system-routes");
const startTime = Date.now();

async function getSystemStats(): Promise<SystemStats> {
  if (isMock()) {
    const mockRunning = sandboxService
      .getByStatus("running")
      .filter((s) => s.workspaceId !== SYSTEM_WORKSPACE_ID);
    return {
      cpuUsage: 25,
      memoryUsed: 4 * 1024 * 1024 * 1024,
      memoryTotal: 16 * 1024 * 1024 * 1024,
      memoryPercent: 25,
      diskUsed: 50 * 1024 * 1024 * 1024,
      diskTotal: 500 * 1024 * 1024 * 1024,
      diskPercent: 10,
      activeSandboxes: mockRunning.length,
      maxSandboxes: config.server.maxSandboxes,
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

  const allRunning = sandboxService.getByStatus("running");
  const userRunning = allRunning.filter(
    (s) => s.workspaceId !== SYSTEM_WORKSPACE_ID,
  );

  return {
    cpuUsage,
    memoryUsed,
    memoryTotal,
    memoryPercent: memoryTotal > 0 ? (memoryUsed / memoryTotal) * 100 : 0,
    diskUsed,
    diskTotal,
    diskPercent: diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0,
    activeSandboxes: userRunning.length,
    maxSandboxes: config.server.maxSandboxes,
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
}

async function performCleanup(): Promise<CleanupResult> {
  log.info("Starting system cleanup");
  return {
    socketsRemoved: 0,
    overlaysRemoved: 0,
    tapDevicesRemoved: 0,
    lvmVolumesRemoved: 0,
    logsRemoved: 0,
    caddyRoutesRemoved: 0,
    sshRoutesRemoved: 0,
    spaceFreed: 0,
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
    "/sandbox",
    async () => {
      const status = systemSandboxService.getStatus();
      const meta = await prebuildRunner.readSystemMetadata();
      return {
        ...status,
        prebuild: {
          exists: await prebuildRunner.hasPrebuild(SYSTEM_WORKSPACE_ID),
          building: prebuildRunner.isSystemBuilding(),
          builtAt: meta?.builtAt ?? null,
        },
      };
    },
    {
      response: SystemSandboxStatusSchema,
      detail: { tags: ["system"] },
    },
  )
  .post(
    "/sandbox/prebuild",
    async () => {
      if (prebuildRunner.isSystemBuilding()) {
        return { started: false, message: "Prebuild already in progress" };
      }
      prebuildRunner.runSystemInBackground();
      return { started: true, message: "System prebuild started" };
    },
    {
      detail: { tags: ["system"] },
    },
  )
  .post(
    "/sandbox/prebuild/cancel",
    async () => {
      if (!prebuildRunner.isSystemBuilding()) {
        return { cancelled: false, message: "No prebuild in progress" };
      }
      await prebuildRunner.cancelSystem();
      return { cancelled: true, message: "System prebuild cancelled" };
    },
    {
      detail: { tags: ["system"] },
    },
  )
  .delete(
    "/sandbox/prebuild",
    async ({ set }) => {
      if (prebuildRunner.isSystemBuilding()) {
        set.status = 409;
        return { message: "Cannot delete while prebuild is in progress" };
      }
      await prebuildRunner.deleteSystem();
      set.status = 204;
      return null;
    },
    {
      detail: { tags: ["system"] },
    },
  )
  .post(
    "/sandbox/start",
    async () => {
      const status = systemSandboxService.getStatus();
      if (status.status === "booting") {
        return {
          success: false,
          message: "System sandbox is already booting",
        };
      }
      if (status.status === "running" || status.status === "idle") {
        return {
          success: true,
          message: "System sandbox is already running",
        };
      }
      await systemSandboxService.ensureRunning();
      return { success: true, message: "System sandbox started" };
    },
    {
      detail: { tags: ["system"] },
    },
  )
  .post(
    "/sandbox/stop",
    async () => {
      const status = systemSandboxService.getStatus();
      if (status.status === "off") {
        return {
          success: true,
          message: "System sandbox is already off",
        };
      }
      if (status.status === "booting") {
        return {
          success: false,
          message: "Cannot stop while booting",
        };
      }
      await systemSandboxService.dispose();
      return { success: true, message: "System sandbox stopped" };
    },
    {
      detail: { tags: ["system"] },
    },
  )
  .post(
    "/sandbox/restart",
    async () => {
      const status = systemSandboxService.getStatus();
      if (status.status === "booting") {
        return {
          success: false,
          message: "Cannot restart while booting",
        };
      }
      if (status.status === "running" || status.status === "idle") {
        await systemSandboxService.dispose();
      }
      await systemSandboxService.ensureRunning();
      return { success: true, message: "System sandbox restarted" };
    },
    {
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
