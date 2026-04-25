export type {
  WorkspaceAdaptor,
  WorkspaceInfo,
  WorkspaceTarget,
} from "@opencode-ai/plugin";

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
