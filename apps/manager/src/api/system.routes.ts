import { Elysia } from "elysia";
import {
  prebuildRunner,
  sandboxService,
  systemSandboxService,
} from "../container.ts";
import { SYSTEM_WORKSPACE_ID } from "../modules/system-sandbox/index.ts";
import {
  SystemSandboxStatusSchema,
  type SystemStats,
  SystemStatsSchema,
} from "../schemas/index.ts";
import { config } from "../shared/lib/config.ts";

const startTime = Date.now();

async function getSystemStats(): Promise<SystemStats> {
  const allRunning = sandboxService.getByStatus("running");
  const userRunning = allRunning.filter(
    (s) => s.workspaceId !== SYSTEM_WORKSPACE_ID,
  );
  return {
    activeSandboxes: userRunning.length,
    maxSandboxes: config.server.maxSandboxes,
    uptime: Math.floor((Date.now() - startTime) / 1000),
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
  );
