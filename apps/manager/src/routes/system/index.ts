import { Elysia, t } from "elysia";
import { SystemService } from "./service.ts";

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
    }
  )
  .post(
    "/cleanup",
    async () => {
      return SystemService.cleanup();
    },
    {
      response: t.Object({
        socketsRemoved: t.Number(),
        overlaysRemoved: t.Number(),
        tapDevicesRemoved: t.Number(),
        spaceFreed: t.Number(),
      }),
    }
  );
