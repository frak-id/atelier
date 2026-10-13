/**
 * The runtime module's public interface — the seam control/ imports.
 *
 * BOUNDARY RULE (design.md §3.1): `runtime/` compiles without `control/` or
 * `sessions/`. Nothing under this folder may import from those modules. This
 * barrel is the only surface the rest of the server is allowed to touch.
 */

export type { TerminalSession } from "./agent/index.ts";
export { AgentClient } from "./agent/index.ts";
export { createSandboxBackend } from "./backend/index.ts";
export { JobService } from "./jobs.service.ts";
export {
  ensureSharedSshPipeKey,
  getSharedSshPipeKeyOpenSSH,
} from "./kube/index.ts";
export {
  createImageBuilder,
  ImageBuilderService,
  readContextDockerfile,
  unpackZipContext,
} from "./registry/index.ts";
export { RuntimeService } from "./runtime.service.ts";
export type { JobRecord } from "./store.ts";
export {
  DrizzleImageStore,
  DrizzleJobStore,
  DrizzleSandboxStore,
  DrizzleSandboxToolsetRefStore,
  DrizzleSnapshotStore,
  DrizzleToolsetStore,
  InMemoryJobStore,
} from "./store.ts";
