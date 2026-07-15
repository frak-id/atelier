/**
 * The runtime backend port + its Kubernetes implementation. RuntimeService
 * depends on the `SandboxBackend`/`VolumeBackend` interfaces; the concrete
 * backend is injected (default: `KubernetesBackend`). See
 * docs/proposals/portable-runtime-backends.md §3.
 */
import { config } from "../../shared/lib/config.ts";
import type { SandboxBackend } from "./backend.types.ts";
import { DockerBackend } from "./docker.backend.ts";
import { KubernetesBackend } from "./kubernetes.backend.ts";

export type {
  AgentEndpoint,
  SandboxBackend,
  SandboxUrl,
  VolumeBackend,
} from "./backend.types.ts";
export { DockerBackend } from "./docker.backend.ts";
export { DockerVolumeBackend } from "./docker-volume.backend.ts";
export {
  CsiVolumeBackend,
  createVolumeBackend,
  KubernetesBackend,
} from "./kubernetes.backend.ts";

/**
 * Select the sandbox orchestration backend from `config.runtime.backend`
 * (docs/proposals/portable-runtime-backends.md §3, §8). Only `kubernetes` is
 * wired today; `docker`/`local` fail fast at construction with a clear message
 * rather than silently falling back — mirrors `createVolumeBackend`.
 */
export function createSandboxBackend(
  backend: (typeof config.runtime)["backend"] = config.runtime.backend,
): SandboxBackend {
  if (backend === "kubernetes") return new KubernetesBackend();
  if (backend === "docker") return new DockerBackend();
  throw new Error(
    `runtime.backend="${backend}" is not yet implemented; "kubernetes" and ` +
      '"docker" are available today (the local-process backend is reserved). ' +
      "Set runtime.backend=kubernetes or docker.",
  );
}
