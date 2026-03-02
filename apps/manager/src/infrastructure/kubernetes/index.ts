import { KubeClient } from "./kube.client.ts";

export type { KubePod } from "./kube.client.ts";
export { KubeApiError, KubeClient } from "./kube.client.ts";
export type {
  IngressOptions,
  KanikoJobOptions,
  KubeResource,
  PvcOptions,
  SandboxPodOptions,
  VolumeSnapshotOptions,
} from "./kube.resources.ts";
export {
  buildConfigMap,
  buildDevCommandIngress,
  buildKanikoJob,
  buildPvc,
  buildSandboxIngress,
  buildSandboxPod,
  buildSandboxService,
  buildVolumeSnapshot,
} from "./kube.resources.ts";
export type {
  JobStatus,
  KubeEvent,
  PodPhase,
  WatchEvent,
} from "./kube.watcher.ts";
export { pollPodReady, readPodEvents, watchPodStatus } from "./kube.watcher.ts";

/**
 * Shared KubeClient singleton — configured from `config.kubernetes`.
 * Import this instead of constructing `new KubeClient()` in each file.
 */
export const kubeClient = new KubeClient();
