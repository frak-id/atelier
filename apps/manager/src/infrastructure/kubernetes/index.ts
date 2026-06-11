import { KubeClient } from "./kube.client.ts";

export type { JobStatus, KubePod, PodPhase } from "./kube.client.ts";
export { KubeApiError, KubeClient } from "./kube.client.ts";
export type {
  IngressOptions,
  KubeResource,
  PvcOptions,
  SandboxPodOptions,
  SshPipeOptions,
  ToolIngressOptions,
  VolumeSnapshotOptions,
} from "./kube.resources.ts";
export {
  buildConfigMap,
  buildDefaultDevIngress,
  buildDevCommandIngress,
  buildPvc,
  buildSandboxPod,
  buildSandboxService,
  buildSshPipe,
  buildToolIngress,
  buildVolumeSnapshot,
  collectDevPorts,
  SHARED_BINARIES_MOUNT_PATH,
  toolHost,
  toolIngressName,
} from "./kube.resources.ts";
export { ensureSharedSshPipeKey } from "./ssh-pipe-key.ts";

/**
 * Shared KubeClient singleton — configured from `config.kubernetes`.
 * Import this instead of constructing `new KubeClient()` in each file.
 */
export const kubeClient = new KubeClient();
