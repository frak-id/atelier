import { Elysia, t } from "elysia";
import type { HealthStatus } from "@frak-sandbox/shared/types";
import { FirecrackerService } from "../services/firecracker.ts";
import { CaddyService } from "../services/caddy.ts";
import { NetworkService } from "../services/network.ts";
import { config } from "../lib/config.ts";
import { dirExists } from "../lib/shell.ts";

const startTime = Date.now();

export const healthRoutes = new Elysia({ prefix: "/health" })
  .get(
    "/",
    async (): Promise<HealthStatus> => {
      const [firecracker, caddy, network, storage] = await Promise.all([
        FirecrackerService.isHealthy(),
        CaddyService.isHealthy(),
        NetworkService.getBridgeStatus().then((s) => s.exists),
        dirExists(config.paths.SANDBOX_DIR),
      ]);

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
        },
      };
    },
    {
      response: t.Object({
        status: t.Union([t.Literal("ok"), t.Literal("degraded"), t.Literal("error")]),
        uptime: t.Number(),
        timestamp: t.Number(),
        checks: t.Object({
          firecracker: t.Union([t.Literal("ok"), t.Literal("error")]),
          caddy: t.Union([t.Literal("ok"), t.Literal("error")]),
          network: t.Union([t.Literal("ok"), t.Literal("error")]),
          storage: t.Union([t.Literal("ok"), t.Literal("error")]),
        }),
      }),
    }
  )
  .get("/live", () => ({ status: "ok" }), {
    response: t.Object({ status: t.Literal("ok") }),
  })
  .get("/ready", async ({ set }) => {
    const firecracker = await FirecrackerService.isHealthy();
    if (!firecracker) {
      set.status = 503;
      return { status: "not ready", reason: "firecracker unavailable" };
    }
    return { status: "ready" };
  });
