/**
 * The runtime backend port + its Kubernetes implementation. RuntimeService
 * depends on the `SandboxBackend`/`VolumeBackend` interfaces; the concrete
 * backend is injected (default: `KubernetesBackend`). See
 * docs/proposals/portable-runtime-backends.md §3.
 */
import { config } from "../../shared/lib/config.ts";
import type { SandboxBackend } from "./backend.types.ts";
import { KubernetesBackend } from "./kubernetes.backend.ts";

export type {
  SandboxBackend,
  SandboxUrl,
  VolumeBackend,
} from "./backend.types.ts";
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
  throw new Error(
    `runtime.backend="${backend}" is not yet implemented; only "kubernetes" ` +
      "is available today (the docker/local backends are the in-progress " +
      "portability work). Set runtime.backend=kubernetes.",
  );
}
