import { Elysia } from "elysia";
import { sandboxService } from "../../container.ts";
import { NetworkService } from "../../infrastructure/network/index.ts";
import { CaddyService } from "../../infrastructure/proxy/index.ts";
import { StorageService } from "../../infrastructure/storage/index.ts";
import {
  type HealthStatus,
  HealthStatusSchema,
  LiveStatusSchema,
  ReadyStatusSchema,
} from "../../schemas/index.ts";
import { config } from "../../shared/lib/config.ts";
import { dirExists } from "../../shared/lib/shell.ts";

const startTime = Date.now();

export const healthRoutes = new Elysia({ prefix: "/health" })
  .get(
    "/",
    async (): Promise<HealthStatus> => {
      const [firecracker, caddy, network, storageDir, lvmAvailable] =
        await Promise.all([
          sandboxService.isHealthy(),
          CaddyService.isHealthy(),
          NetworkService.getBridgeStatus().then((s) => s.exists),
          dirExists(config.paths.SANDBOX_DIR),
          StorageService.isAvailable(),
        ]);

      const storage = storageDir || lvmAvailable;
      const allHealthy = firecracker && caddy && network && storage;

      return {
        status: allHealthy ? "ok" : "degraded",
        uptime: Math.floor((Date.now() - startTime) / 1000),
        timestamp: Date.now(),
        checks: {
          firecracker: firecracker ? "ok" : "error",
          caddy: caddy ? "ok" : "error",
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
      const firecracker = await sandboxService.isHealthy();
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
  );
