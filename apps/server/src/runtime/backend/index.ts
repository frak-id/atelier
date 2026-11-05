/**
 * The runtime backend port + its Kubernetes and Docker implementations.
 * RuntimeService depends on the `SandboxBackend`/`VolumeBackend` interfaces;
 * the concrete backend is injected (default: from `config.runtime.backend`).
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

/** Select the sandbox orchestration backend from `config.runtime.backend`:
 * Kubernetes (production) or Docker (local mode). */
export function createSandboxBackend(
  backend: (typeof config.runtime)["backend"] = config.runtime.backend,
): SandboxBackend {
  return backend === "docker" ? new DockerBackend() : new KubernetesBackend();
}
