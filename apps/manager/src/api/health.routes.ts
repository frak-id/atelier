import { Elysia, t } from "elysia";
import { CronService } from "../infrastructure/cron/index.ts";
import { kubeClient } from "../infrastructure/kubernetes/index.ts";
import {
  CronJobInfoSchema,
  type HealthStatus,
  HealthStatusSchema,
  LiveStatusSchema,
  ReadyStatusSchema,
} from "../schemas/index.ts";
import { config, isMock } from "../shared/lib/config.ts";

const startTime = Date.now();

/**
 * Check if the Zot OCI registry is reachable.
 */
async function checkZotHealth(): Promise<boolean> {
  if (isMock()) return true;
  try {
    const res = await fetch(`http://${config.kubernetes.registryUrl}/v2/`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export const healthRoutes = new Elysia({ prefix: "/health" })
  .get(
    "/",
    async (): Promise<HealthStatus> => {
      const [kubernetes, kata, registry, snapshots] = await Promise.all([
        kubeClient.checkApiHealth(),
        kubeClient.checkRuntimeClass(),
        checkZotHealth(),
        kubeClient.checkSnapshotApi(),
      ]);

      const allHealthy = kubernetes && kata && registry;

      return {
        status: allHealthy ? "ok" : "degraded",
        uptime: Math.floor((Date.now() - startTime) / 1000),
        timestamp: Date.now(),
        checks: {
          kubernetes: kubernetes ? "ok" : "error",
          kata: kata ? "ok" : "error",
          registry: registry ? "ok" : "error",
          snapshots: snapshots ? "ok" : "error",
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
      const kubernetes = await kubeClient.checkApiHealth();
      if (!kubernetes) {
        set.status = 503;
        return {
          status: "not ready" as const,
          reason: "kubernetes api unavailable",
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
