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
}

export type { Sandbox } from "@frak/atelier-manager/types";
export type { AtelierConfig as AtelierPluginConfig } from "./config.ts";
