import { Elysia, t } from "elysia";
import { kubeClient } from "../container.ts";
import type {
  BuildKitStatusSchema,
  PlatformOverviewSchema,
  RunnersStatusSchema,
} from "../schemas/index.ts";
import { config, isMock } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("platform-routes");

type BuildKitStatus = (typeof BuildKitStatusSchema)["static"];
type RunnersStatus = (typeof RunnersStatusSchema)["static"];
type PlatformOverview = (typeof PlatformOverviewSchema)["static"];

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

type PodMetricsMap = Map<
  string,
  Array<{ name: string; cpu: string; memory: string }>
>;

function toPodInfo(pod: RawPod, metricsMap: PodMetricsMap) {
  const podName = pod.metadata?.name ?? "";
  const conditions = pod.status?.conditions ?? [];
  const ready = conditions.some(
    (condition) => condition.type === "Ready" && condition.status === "True",
  );
  const containers = pod.status?.containerStatuses ?? [];
  const restarts = containers.reduce(
    (sum, container) => sum + (container.restartCount ?? 0),
    0,
  );
  const startedAt = containers[0]?.state?.running?.startedAt ?? null;

  const metrics = metricsMap.get(podName);
  let cpu: string | null = null;
  let memory: string | null = null;

  if (metrics?.length) {
    cpu = metrics.map((container) => container.cpu).join(" + ");
    memory = metrics.map((container) => container.memory).join(" + ");
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

function buildMetricsMap(
  metrics: Array<{
    podName: string;
    containers: Array<{ name: string; cpu: string; memory: string }>;
  }>,
): PodMetricsMap {
  const metricsMap: PodMetricsMap = new Map();
  for (const metric of metrics) {
    metricsMap.set(metric.podName, metric.containers);
  }
  return metricsMap;
}

async function getBuildKitStatus(): Promise<BuildKitStatus> {
  if (!config.platform.buildkit.enabled || isMock()) {
    return {
      enabled: false,
      pods: [],
      pvcs: [],
    };
  }

  const namespace =
    config.platform.buildkit.namespace || config.kubernetes.systemNamespace;

  try {
    const [pods, metrics, pvcs] = await Promise.all([
      kubeClient
        .listPods(config.platform.buildkit.labelSelector, namespace)
        .catch(() => []),
      kubeClient.listPodMetrics(namespace).catch(() => []),
      kubeClient.listPvcs(namespace).catch(() => []),
    ]);

    const metricsMap = buildMetricsMap(metrics);
    const buildkitPods = (pods as RawPod[]).map((pod) =>
      toPodInfo(pod, metricsMap),
    );
    const buildkitPvcs = pvcs.filter((pvc) =>
      pvc.name.toLowerCase().includes("buildkit"),
    );

    return {
      enabled: true,
      pods: buildkitPods,
      pvcs: buildkitPvcs,
    };
  } catch (err) {
    log.warn({ err }, "Failed to fetch BuildKit status");
    return {
      enabled: true,
      pods: [],
      pvcs: [],
    };
  }
}

async function getRunnersStatus(): Promise<RunnersStatus> {
  if (!config.platform.runners.enabled || isMock()) {
    return {
      enabled: false,
      pods: [],
      activeJobs: 0,
      idleRunners: 0,
      totalRunners: 0,
    };
  }

  try {
    const [pods, metrics] = await Promise.all([
      kubeClient
        .listPods(
          config.platform.runners.labelSelector,
          config.platform.runners.namespace,
        )
        .catch(() => []),
      kubeClient
        .listPodMetrics(config.platform.runners.namespace)
        .catch(() => []),
    ]);

    const metricsMap = buildMetricsMap(metrics);
    const runnerPods = (pods as RawPod[]).map((pod) => {
      const podInfo = toPodInfo(pod, metricsMap);
      const runnerId =
        pod.metadata?.labels?.["actions.github.com/runner-name"] ??
        podInfo.name;

      return {
        ...podInfo,
        runnerId,
      };
    });

    const totalRunners = runnerPods.length;
    const activeJobs = runnerPods.filter(
      (pod) => pod.status === "Running",
    ).length;

    return {
      enabled: true,
      pods: runnerPods,
      activeJobs,
      idleRunners: totalRunners - activeJobs,
      totalRunners,
    };
  } catch (err) {
    log.warn({ err }, "Failed to fetch ARC runner status");
    return {
      enabled: true,
      pods: [],
      activeJobs: 0,
      idleRunners: 0,
      totalRunners: 0,
    };
  }
}

async function getPlatformOverview(): Promise<PlatformOverview> {
  const [buildkit, runners] = await Promise.all([
    getBuildKitStatus(),
    getRunnersStatus(),
  ]);

  return {
    buildkit,
    runners,
  };
}

export const platformRoutes = new Elysia({ prefix: "/platform" })
  .get(
    "/buildkit",
    async () => {
      return getBuildKitStatus();
    },
    {
      response: t.Object({
        enabled: t.Boolean(),
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
      detail: { tags: ["platform"] },
    },
  )
  .get(
    "/runners",
    async () => {
      return getRunnersStatus();
    },
    {
      response: t.Object({
        enabled: t.Boolean(),
        pods: t.Array(
          t.Object({
            name: t.String(),
            status: t.String(),
            ready: t.Boolean(),
            restarts: t.Number(),
            startedAt: t.Nullable(t.String()),
            cpu: t.Nullable(t.String()),
            memory: t.Nullable(t.String()),
            runnerId: t.String(),
          }),
        ),
        activeJobs: t.Number(),
        idleRunners: t.Number(),
        totalRunners: t.Number(),
      }),
      detail: { tags: ["platform"] },
    },
  )
  .get(
    "/overview",
    async () => {
      return getPlatformOverview();
    },
    {
      response: t.Object({
        buildkit: t.Object({
          enabled: t.Boolean(),
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
        runners: t.Object({
          enabled: t.Boolean(),
          pods: t.Array(
            t.Object({
              name: t.String(),
              status: t.String(),
              ready: t.Boolean(),
              restarts: t.Number(),
              startedAt: t.Nullable(t.String()),
              cpu: t.Nullable(t.String()),
              memory: t.Nullable(t.String()),
              runnerId: t.String(),
            }),
          ),
          activeJobs: t.Number(),
          idleRunners: t.Number(),
          totalRunners: t.Number(),
        }),
      }),
      detail: { tags: ["platform"] },
    },
  );
