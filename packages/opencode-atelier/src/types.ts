/**
 * Persistable per-opencode-workspace config.
 *
 * Set in `adaptor.configure()` and stored verbatim in opencode's workspace DB.
 * Anything mutated outside `configure()`'s return value is discarded — runtime
 * data (sandbox id, URL, password) lives in the in-memory runtime cache and is
 * recovered on demand via `GET /sandboxes?originSource=opencode-plugin&originExternalId=<workspaceId>`.
 */
export interface AtelierExtra {
  /** e.g. "http://localhost:4000" */
  managerUrl: string;
  /** Which atelier workspace to spawn the sandbox in */
  atelierWorkspaceId: string;
  /** Optional branch override (forwarded to `POST /sandboxes`) */
  branch?: string;
  /**
   * Local OpenCode `project_id` captured at `configure()` time.
   *
   * Sessions are FK-bound to `project.id` (`session.sql.ts:23`). Because
   * sandboxes are shallow-cloned, the remote computes a different
   * `project_id` than the local CLI — so `/sync/replay` violates the FK
   * on every batch. We forward this id to the sandbox so the server-side
   * pre-register plugin can alias it into the remote `project` table
   * before the warp arrives.
   */
  sourceProjectID?: string;
  /**
   * Local OpenCode `workspace_id` captured at `configure()` time.
   * `session.workspace_id` is NOT FK-constrained (`session.sql.ts:25`),
   * so this is informational — useful for log correlation, not required
   * for warp correctness.
   */
  sourceWorkspaceID?: string;
}

export type { Sandbox } from "@frak/atelier-manager/types";
export type { AtelierConfig as AtelierPluginConfig } from "./config.ts";
