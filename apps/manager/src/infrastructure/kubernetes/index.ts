import { KubeClient } from "./kube.client.ts";

export type { KubePod } from "./kube.client.ts";
export { KubeApiError, KubeClient } from "./kube.client.ts";
export type {
  IngressOptions,
  KanikoJobOptions,
  KubeResource,
  PvcOptions,
  SandboxPodOptions,
  SharedBinariesJobOptions,
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
  buildSharedBinariesJob,
  buildSharedBinariesPv,
  buildSharedBinariesPvc,
  buildVolumeSnapshot,
  SHARED_BINARIES_LABELS,
  SHARED_BINARIES_MOUNT_PATH,
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
