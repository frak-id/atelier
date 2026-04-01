// Mirrors of opencode internals (control-plane/types.ts) —
// not exported by @opencode-ai/plugin, so duplicated here.

export interface WorkspaceInfo {
  id: string;
  type: string;
  branch: string | null;
  name: string | null;
  directory: string | null;
  extra: unknown;
  projectID: string;
}

export interface Adaptor {
  configure(input: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>;
  create(input: WorkspaceInfo, from?: WorkspaceInfo): Promise<void>;
  remove(config: WorkspaceInfo): Promise<void>;
  fetch(
    config: WorkspaceInfo,
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response>;
}

export interface AtelierExtra {
  /** e.g. "http://localhost:4000" */
  managerUrl: string;
  /** Which atelier workspace to create tasks in */
  atelierWorkspaceId: string;
  /** Task description / AI prompt */
  description: string;
  /** Git base branch (defaults to repo default) */
  baseBranch?: string;

  /** Set after adaptor.create() completes */
  taskId?: string;
  sandboxId?: string;
  /** URL of sandbox's opencode (e.g. http://10.0.0.5:8000) */
  sandboxOpencodeUrl?: string;
  opencodePassword?: string;
}

export type { Sandbox, Task } from "@frak/atelier-manager/types";
export type { AtelierConfig as AtelierPluginConfig } from "./config.ts";
