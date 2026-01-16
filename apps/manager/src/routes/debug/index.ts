import { Elysia, t } from "elysia";
import { config } from "../../lib/config.ts";
import { CaddyService } from "../../services/caddy.ts";
import { FirecrackerService } from "../../services/firecracker.ts";
import { NetworkService } from "../../services/network.ts";
import { sandboxStore } from "../../state/store.ts";

export const debugRoutes = new Elysia({ prefix: "/debug" })
  .guard({
    beforeHandle: ({ set }) => {
      if (config.isProduction() && process.env.ENABLE_DEBUG !== "true") {
        set.status = 403;
        return { error: "Debug endpoints disabled in production" };
      }
    },
  })
  .get("/config", () => ({
    mode: config.mode,
    port: config.port,
    host: config.host,
    paths: config.paths,
    network: config.network,
    caddy: config.caddy,
    defaults: config.defaults,
  }))
  .get("/caddy", async () => {
    const [fullConfig, routes] = await Promise.all([
      CaddyService.getConfig(),
      CaddyService.getRoutes(),
    ]);

    return {
      config: fullConfig,
      routes,
      sandboxRouteCount: routes.length,
    };
  })
  .get("/network", async () => {
    const [bridgeStatus, tapDevices] = await Promise.all([
      NetworkService.getBridgeStatus(),
      NetworkService.listTapDevices(),
    ]);

    return {
      bridge: bridgeStatus,
      tapDevices,
      tapDeviceCount: tapDevices.length,
    };
  })
  .get(
    "/firecracker/:id",
    async ({ params }) => {
      const sandbox = sandboxStore.getById(params.id);
      if (!sandbox) {
        return { error: "Sandbox not found", sandboxId: params.id };
      }

      const state = await FirecrackerService.getFirecrackerState(params.id);
      return {
        sandbox: {
          id: sandbox.id,
          status: sandbox.status,
          pid: sandbox.pid,
          ipAddress: sandbox.ipAddress,
        },
        firecrackerState: state,
      };
    },
    {
      params: t.Object({ id: t.String() }),
    },
  )
  .get("/store", () => ({
    sandboxes: sandboxStore.getAll(),
    count: sandboxStore.count(),
    byStatus: {
      creating: sandboxStore.countByStatus("creating"),
      running: sandboxStore.countByStatus("running"),
      stopped: sandboxStore.countByStatus("stopped"),
      error: sandboxStore.countByStatus("error"),
    },
  }));
