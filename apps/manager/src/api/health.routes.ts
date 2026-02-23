import { PATHS } from "@frak/atelier-shared/constants";
import { Elysia, t } from "elysia";
import { CronService } from "../infrastructure/cron/index.ts";
import { FirecrackerClient } from "../infrastructure/firecracker/index.ts";
import { networkService } from "../infrastructure/network/index.ts";
import { proxyService } from "../infrastructure/proxy/index.ts";
import { StorageService } from "../infrastructure/storage/index.ts";
import {
  CronJobInfoSchema,
  type HealthStatus,
  HealthStatusSchema,
  LiveStatusSchema,
  ReadyStatusSchema,
} from "../schemas/index.ts";
import { dirExists } from "../shared/lib/shell.ts";

const startTime = Date.now();

export const healthRoutes = new Elysia({ prefix: "/health" })
  .get(
    "/",
    async (): Promise<HealthStatus> => {
      const [firecracker, proxy, network, storageDir, lvmAvailable] =
        await Promise.all([
          FirecrackerClient.isHealthy(),
          proxyService.isHealthy(),
          networkService.getBridgeStatus().then((s) => s.exists),
          dirExists(PATHS.SANDBOX_DIR),
          StorageService.isAvailable(),
        ]);

      const storage = storageDir || lvmAvailable;
      const allHealthy = firecracker && proxy && network && storage;

      return {
        status: allHealthy ? "ok" : "degraded",
        uptime: Math.floor((Date.now() - startTime) / 1000),
        timestamp: Date.now(),
        checks: {
          firecracker: firecracker ? "ok" : "error",
          proxy: proxy ? "ok" : "error",
          network: network ? "ok" : "error",
          storage: storage ? "ok" : "error",
          lvm: lvmAvailable ? "ok" : "unavailable",
        },
      };
    },
    {
      response: HealthStatusSchema,
    },
  )
  .get("/live", () => ({ status: "ok" as const }), {
    response: LiveStatusSchema,
  })
  .get(
    "/ready",
    async ({ set }) => {
      const firecracker = await FirecrackerClient.isHealthy();
      if (!firecracker) {
        set.status = 503;
        return {
          status: "not ready" as const,
          reason: "firecracker unavailable",
        };
      }
      return { status: "ready" as const };
    },
    {
      response: ReadyStatusSchema,
    },
  )
  .get("/cron", () => CronService.getStatus(), {
    response: t.Record(t.String(), CronJobInfoSchema),
  });
