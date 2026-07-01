/**
 * The runtime module's public interface — the seam control/ imports.
 *
 * BOUNDARY RULE (atelier-v2 §3.1): `runtime/` compiles without `control/` or
 * `sessions/`. Nothing under this folder may import from those modules. This
 * barrel is the only surface the rest of the server is allowed to touch.
 */

export { AgentClient, AgentOperations } from "./agent/index.ts";
export {
  type RuntimeCreateOptions,
  type RuntimeDeps,
  RuntimeService,
} from "./runtime.service.ts";
export type {
  SandboxRecord,
  SandboxStore,
  SnapshotRecord,
  SnapshotStore,
} from "./store.ts";
