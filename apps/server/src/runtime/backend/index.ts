/**
 * The runtime backend port + its Kubernetes implementation. RuntimeService
 * depends on the `SandboxBackend`/`VolumeBackend` interfaces; the concrete
 * backend is injected (default: `KubernetesBackend`). See
 * docs/proposals/portable-runtime-backends.md §3.
 */
export type {
  SandboxBackend,
  SandboxUrl,
  VolumeBackend,
} from "./backend.types.ts";
export { CsiVolumeBackend, KubernetesBackend } from "./kubernetes.backend.ts";
