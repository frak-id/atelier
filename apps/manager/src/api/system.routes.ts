import { Elysia, t } from "elysia";
import {
  kubeClient,
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
import { createChildLogger } from "../shared/lib/logger.ts";

const startTime = Date.now();
const log = createChildLogger("system-routes");

type RawPod = {
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
    creationTimestamp?: string;
  };
  status?: {
    phase?: string;
    conditions?: Array<{ type?: string; status?: string }>;
    containerStatuses?: Array<{
      name?: string;
      restartCount?: number;
      state?: {
        running?: { startedAt?: string };
      };
    }>;
  };
};

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
  )
  .get(
    "/services",
    async () => {
      const systemNs = config.kubernetes.systemNamespace;
      const sandboxNs = config.kubernetes.namespace;

      const systemComponents = ["manager", "verdaccio", "cliproxy", "zot"];

      const [
        systemPods,
        sandboxPods,
        systemMetrics,
        sandboxMetrics,
        systemPvcs,
        sandboxPvcs,
      ] = await Promise.all([
        kubeClient
          .listPods("app.kubernetes.io/name=atelier", systemNs)
          .catch(() => []),
        kubeClient
          .listPods("atelier.dev/component=sandbox", sandboxNs)
          .catch(() => []),
        kubeClient.listPodMetrics(systemNs),
        kubeClient.listPodMetrics(sandboxNs),
        kubeClient.listPvcs(systemNs),
        kubeClient.listPvcs(sandboxNs),
      ]);

      const metricsMap = new Map<
        string,
        Array<{ name: string; cpu: string; memory: string }>
      >();
      for (const m of [...systemMetrics, ...sandboxMetrics]) {
        metricsMap.set(m.podName, m.containers);
      }

      function toPodInfo(pod: RawPod) {
        const podName = pod.metadata?.name ?? "";
        const conditions = pod.status?.conditions ?? [];
        const ready = conditions.some(
          (c) => c.type === "Ready" && c.status === "True",
        );
        const containers = pod.status?.containerStatuses ?? [];
        const restarts = containers.reduce(
          (sum, c) => sum + (c.restartCount ?? 0),
          0,
        );
        const startedAt = containers[0]?.state?.running?.startedAt ?? null;

        const metrics = metricsMap.get(podName);
        let cpu: string | null = null;
        let memory: string | null = null;
        if (metrics?.length) {
          cpu = metrics.map((c) => c.cpu).join(" + ");
          memory = metrics.map((c) => c.memory).join(" + ");
        }

        return {
          name: podName,
          status: pod.status?.phase ?? "Unknown",
          ready,
          restarts,
          startedAt,
          cpu,
          memory,
        };
      }

      const services = systemComponents.map((component) => {
        const pods = (systemPods as RawPod[])
          .filter(
            (p) =>
              p.metadata?.labels?.["app.kubernetes.io/component"] === component,
          )
          .map(toPodInfo);

        const componentPvcs = systemPvcs.filter((pvc) =>
          pvc.name.includes(component),
        );

        return {
          component,
          namespace: systemNs,
          pods,
          pvcs: componentPvcs,
        };
      });

      const sandboxPodInfos = (sandboxPods as RawPod[]).map((pod) => {
        const podInfo = toPodInfo(pod);
        const sandboxId =
          pod.metadata?.labels?.["atelier.dev/sandbox"] ?? "unknown";
        return { ...podInfo, sandboxId };
      });

      const sandboxPvcList = sandboxPvcs.filter(
        (pvc) => pvc.name !== "shared-binaries",
      );

      return {
        system: services,
        sandboxes: {
          pods: sandboxPodInfos,
          pvcs: sandboxPvcList,
        },
      };
    },
    {
      response: t.Object({
        system: t.Array(
          t.Object({
            component: t.String(),
            namespace: t.String(),
            pods: t.Array(
              t.Object({
                name: t.String(),
                status: t.String(),
                ready: t.Boolean(),
                restarts: t.Number(),
                startedAt: t.Nullable(t.String()),
                cpu: t.Nullable(t.String()),
                memory: t.Nullable(t.String()),
              }),
            ),
            pvcs: t.Array(
              t.Object({
                name: t.String(),
                capacity: t.String(),
                phase: t.String(),
              }),
            ),
          }),
        ),
        sandboxes: t.Object({
          pods: t.Array(
            t.Object({
              name: t.String(),
              status: t.String(),
              ready: t.Boolean(),
              restarts: t.Number(),
              startedAt: t.Nullable(t.String()),
              cpu: t.Nullable(t.String()),
              memory: t.Nullable(t.String()),
              sandboxId: t.String(),
            }),
          ),
          pvcs: t.Array(
            t.Object({
              name: t.String(),
              capacity: t.String(),
              phase: t.String(),
            }),
          ),
        }),
      }),
      detail: { tags: ["system"] },
    },
  )
  .get(
    "/shared-binaries",
    async () => {
      const sandboxNs = config.kubernetes.namespace;

      try {
        const jobs = await kubeClient.listJobs(
          "atelier.dev/component=shared-binaries",
          sandboxNs,
        );

        if (jobs.length === 0) {
          return {
            opencode: null,
            codeServer: null,
            jobStatus: null,
            lastUpdated: null,
          };
        }

        const sorted = [...jobs].sort((a, b) => {
          const aTime = a.metadata?.creationTimestamp ?? "";
          const bTime = b.metadata?.creationTimestamp ?? "";
          return bTime.localeCompare(aTime);
        });

        const latest = sorted[0];
        const status = latest?.status;
        let jobStatus: string = "unknown";
        if ((status?.succeeded ?? 0) > 0) jobStatus = "succeeded";
        else if ((status?.failed ?? 0) > 0) jobStatus = "failed";
        else if ((status?.active ?? 0) > 0) jobStatus = "active";

        const lastUpdated =
          status?.completionTime ?? latest?.metadata?.creationTimestamp ?? null;

        let opencode: string | null = null;
        let codeServer: string | null = null;

        const jobDetail = await kubeClient
          .get<{
            spec?: {
              template?: {
                spec?: {
                  containers?: Array<{
                    args?: string[];
                  }>;
                };
              };
            };
          }>(
            `/apis/batch/v1/namespaces/${sandboxNs}/jobs/${latest?.metadata?.name}`,
          )
          .catch(() => null);

        const args =
          jobDetail?.spec?.template?.spec?.containers?.[0]?.args?.[0] ?? "";
        const fpMatch = args.match(/FINGERPRINT="([^"]+)"/);
        if (fpMatch?.[1]) {
          const fp = fpMatch[1];
          const ocMatch = fp.match(/opencode@([^,"\s]+)/);
          const csMatch = fp.match(/code-server@([^,"\s]+)/);
          opencode = ocMatch?.[1] ?? null;
          codeServer = csMatch?.[1] ?? null;
        }

        return {
          opencode,
          codeServer,
          jobStatus,
          lastUpdated,
        };
      } catch (err) {
        log.warn({ err }, "Failed to fetch shared-binaries info");
        return {
          opencode: null,
          codeServer: null,
          jobStatus: null,
          lastUpdated: null,
        };
      }
    },
    {
      response: t.Object({
        opencode: t.Nullable(t.String()),
        codeServer: t.Nullable(t.String()),
        jobStatus: t.Nullable(t.String()),
        lastUpdated: t.Nullable(t.String()),
      }),
      detail: { tags: ["system"] },
    },
  );
