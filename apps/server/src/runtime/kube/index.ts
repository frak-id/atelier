import { KubeClient } from "./kube.client.ts";

export { KubeApiError } from "./kube.client.ts";
export type { KubeResource } from "./kube.resources.ts";
export {
  buildPvc,
  buildSandboxPod,
  buildSandboxService,
  buildSshPipe,
  buildToolIngress,
  buildVolumeSnapshot,
  toolHost,
  toolIngressName,
} from "./kube.resources.ts";
export { buildKnownHostsData } from "./ssh-known-hosts.ts";
export {
  ensureSharedSshPipeKey,
  getSharedSshPipeKeyOpenSSH,
} from "./ssh-pipe-key.ts";

/**
 * Shared KubeClient singleton — configured from `config.kubernetes`.
 * Import this instead of constructing `new KubeClient()` in each file.
 */
export const kubeClient = new KubeClient();
