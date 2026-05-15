import { KubeClient } from "./kube.client.ts";

export type { KubePod } from "./kube.client.ts";
export { KubeApiError, KubeClient } from "./kube.client.ts";
export type {
  IngressOptions,
  KubeResource,
  PvcOptions,
  SandboxPodOptions,
  SshPipeOptions,
  VolumeSnapshotOptions,
} from "./kube.resources.ts";
export {
  buildBrowserIngress,
  buildConfigMap,
  buildDefaultDevIngress,
  buildDevCommandIngress,
  buildOpenCodeIngress,
  buildPvc,
  buildSandboxPod,
  buildSandboxService,
  buildSshPipe,
  buildVolumeSnapshot,
  buildVsCodeIngress,
  collectDevPorts,
  SHARED_BINARIES_MOUNT_PATH,
} from "./kube.resources.ts";
export type {
  JobStatus,
  KubeEvent,
  PodPhase,
  WatchEvent,
} from "./kube.watcher.ts";
export { pollPodReady, readPodEvents, watchPodStatus } from "./kube.watcher.ts";
export { ensureSharedSshPipeKey } from "./ssh-pipe-key.ts";

/**
 * Shared KubeClient singleton — configured from `config.kubernetes`.
 * Import this instead of constructing `new KubeClient()` in each file.
 */
export const kubeClient = new KubeClient();
