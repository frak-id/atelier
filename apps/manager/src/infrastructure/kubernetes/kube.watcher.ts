import type { KubeClient } from "./kube.client.ts";

export type PodPhase =
  | "Pending"
  | "Running"
  | "Succeeded"
  | "Failed"
  | "Unknown";

export type JobStatus = "active" | "succeeded" | "failed" | "unknown";

export type KubeEvent = {
  type: string;
  reason: string;
  message: string;
  lastTimestamp: string;
};

export type WatchEvent = {
  type: "ADDED" | "MODIFIED" | "DELETED";
  object: unknown;
};

type WatchPod = {
  status?: {
    phase?: string;
    message?: string;
    containerStatuses?: Array<{
      state?: {
        waiting?: {
          reason?: string;
          message?: string;
        };
      };
    }>;
  };
};

export async function watchPodStatus(
  client: KubeClient,
  podName: string,
  callback: (phase: PodPhase, message?: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const fieldSelector = encodeURIComponent(`metadata.name=${podName}`);
  const path =
    `/api/v1/namespaces/${client.namespace}` +
    `/pods?watch=true&fieldSelector=${fieldSelector}`;

  await client.watch(
    path,
    (event) => {
      const pod = event.object as WatchPod;
      const phase = toPodPhase(pod.status?.phase);
      const waiting = pod.status?.containerStatuses?.[0]?.state?.waiting;
      const message =
        waiting?.message ?? waiting?.reason ?? pod.status?.message ?? undefined;
      callback(phase, message);
    },
    signal,
  );
}

export async function pollPodReady(
  client: KubeClient,
  podName: string,
  options: { timeout?: number; interval?: number } = {},
): Promise<boolean> {
  const timeout = options.timeout ?? 60_000;
  const interval = options.interval ?? 1000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    const phase = await client.getPodStatus(podName);
    if (phase === "Running") {
      return true;
    }
    if (phase === "Failed") {
      return false;
    }
    await Bun.sleep(interval);
  }

  return false;
}

export async function readPodEvents(
  client: KubeClient,
  podName: string,
): Promise<KubeEvent[]> {
  const selector = encodeURIComponent(`involvedObject.name=${podName}`);
  const path =
    `/api/v1/namespaces/${client.namespace}` +
    `/events?fieldSelector=${selector}`;
  const response = await client.list<{
    items?: Array<{
      type?: string;
      reason?: string;
      message?: string;
      lastTimestamp?: string;
      eventTime?: string;
    }>;
  }>(path);

  const items = response.items ?? [];
  return items.map((item) => ({
    type: item.type ?? "Unknown",
    reason: item.reason ?? "Unknown",
    message: item.message ?? "",
    lastTimestamp:
      item.lastTimestamp ?? item.eventTime ?? new Date(0).toISOString(),
  }));
}

function toPodPhase(phase: string | undefined): PodPhase {
  if (phase === "Pending") return "Pending";
  if (phase === "Running") return "Running";
  if (phase === "Succeeded") return "Succeeded";
  if (phase === "Failed") return "Failed";
  return "Unknown";
}
