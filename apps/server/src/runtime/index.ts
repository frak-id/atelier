/**
 * The runtime module's public interface — the seam control/ imports.
 *
 * BOUNDARY RULE (atelier-v2 §3.1): `runtime/` compiles without `control/` or
 * `sessions/`. Nothing under this folder may import from those modules. This
 * barrel is the only surface the rest of the server is allowed to touch.
 */

export type { TerminalSession } from "./agent/index.ts";
export { AgentClient } from "./agent/index.ts";
export {
  CsiVolumeBackend,
  createSandboxBackend,
  KubernetesBackend,
  type SandboxBackend,
  type VolumeBackend,
} from "./backend/index.ts";
export { ensureSharedSshPipeKey } from "./kube/index.ts";
export {
  createImageBuilder,
  type ImageBuilderBackend,
  type ImageBuilderDeps,
  ImageBuilderService,
  type ImageBuildRequest,
  type ImageBuildResult,
  ImageNotAvailableError,
  RegistryUnreachableError,
  readContextDockerfile,
  type SeedManifest,
  type SeedSubstitution,
  unpackZipContext,
} from "./registry/index.ts";
export {
  type RuntimeCreateOptions,
  type RuntimeDeps,
  RuntimeService,
} from "./runtime.service.ts";
export type {
  ImageProvenance,
  ImageRecord,
  ImageStatus,
  ImageStore,
  SandboxRecord,
  SandboxStore,
  SandboxToolsetRefEntry,
  SandboxToolsetRefStore,
  SnapshotRecord,
  SnapshotStore,
  ToolsetRecord,
  ToolsetStore,
} from "./store.ts";
export {
  DrizzleImageStore,
  DrizzleSandboxStore,
  DrizzleSandboxToolsetRefStore,
  DrizzleSnapshotStore,
  DrizzleToolsetStore,
  InMemoryImageStore,
  InMemorySandboxToolsetRefStore,
} from "./store.ts";
