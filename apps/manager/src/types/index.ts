export type GitSourceType = "github" | "gitlab" | "custom";

export interface GitHubSourceConfig {
  accessToken: string;
  userId: string;
  username: string;
  avatarUrl?: string;
}

export interface GitLabSourceConfig {
  accessToken: string;
  baseUrl?: string;
  userId: string;
  username: string;
}

export interface CustomSourceConfig {
  baseUrl: string;
  accessToken?: string;
}

export type GitSourceConfig =
  | GitHubSourceConfig
  | GitLabSourceConfig
  | CustomSourceConfig;

export interface GitSource {
  id: string;
  type: GitSourceType;
  name: string;
  config: GitSourceConfig;
  createdAt: string;
  updatedAt: string;
}

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

export type SandboxStatus = "creating" | "running" | "stopped" | "error";

export interface SandboxUrls {
  vscode: string;
  opencode: string;
  terminal: string;
  ssh: string;
}

export interface SandboxRuntime {
  ipAddress: string;
  macAddress: string;
  urls: SandboxUrls;
  vcpus: number;
  memoryMb: number;
  pid?: number;
  error?: string;
}

export interface Sandbox {
  id: string;
  workspaceId?: string;
  status: SandboxStatus;
  runtime: SandboxRuntime;
  createdAt: string;
  updatedAt: string;
}

export type ConfigFileContentType = "json" | "text" | "binary";
export type ConfigFileScope = "global" | "workspace";

export interface ConfigFile {
  id: string;
  path: string;
  content: string;
  contentType: ConfigFileContentType;
  scope: ConfigFileScope;
  workspaceId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkspaceOptions {
  name: string;
  config: Partial<WorkspaceConfig>;
}

export interface UpdateWorkspaceOptions {
  name?: string;
  config?: Partial<WorkspaceConfig>;
}

export interface CreateSandboxOptions {
  workspaceId?: string;
  baseImage?: string;
  vcpus?: number;
  memoryMb?: number;
}

export interface CreateGitSourceOptions {
  type: GitSourceType;
  name: string;
  config: GitSourceConfig;
}

export interface UpdateGitSourceOptions {
  name?: string;
  config?: Partial<GitSourceConfig>;
}

export interface CreateConfigFileOptions {
  path: string;
  content: string;
  contentType: ConfigFileContentType;
  scope: ConfigFileScope;
  workspaceId?: string;
}

export interface UpdateConfigFileOptions {
  content?: string;
  contentType?: ConfigFileContentType;
}

export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
  baseImage: "dev-base",
  vcpus: 2,
  memoryMb: 2048,
  initCommands: [],
  startCommands: [],
  secrets: {},
  repos: [],
  exposedPorts: [],
};
