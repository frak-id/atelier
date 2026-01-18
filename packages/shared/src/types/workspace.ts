export type PrebuildStatus = "none" | "building" | "ready" | "failed";

export type RepoConfig =
  | { url: string; branch: string; clonePath: string }
  | { sourceId: string; repo: string; branch: string; clonePath: string };

export interface WorkspaceConfig {
  baseImage: string;
  vcpus: number;
  memoryMb: number;
  initCommands: string[];
  startCommands: string[];
  secrets: Record<string, string>;
  repos: RepoConfig[];
  exposedPorts: number[];
  prebuild?: {
    status: PrebuildStatus;
    latestId?: string;
    builtAt?: string;
  };
}

export interface Workspace {
  id: string;
  name: string;
  config: WorkspaceConfig;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceOptions {
  name: string;
  config?: Partial<WorkspaceConfig>;
}

export interface UpdateWorkspaceOptions {
  name?: string;
  config?: Partial<WorkspaceConfig>;
}
