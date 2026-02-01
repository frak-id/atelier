export interface AgentHealth {
  status: string;
  sandboxId?: string;
  services: {
    vscode: boolean;
    opencode: boolean;
    sshd: boolean;
    ttyd: boolean;
  };
  uptime: number;
}

export interface AgentMetrics {
  cpu: number;
  memory: { total: number; used: number; free: number };
  disk: { total: number; used: number; free: number };
  timestamp: string;
}

export interface AppPort {
  port: number;
  name: string;
  registeredAt: string;
}

export interface ServiceStatus {
  name: string;
  status: "running" | "stopped" | "error";
  running: boolean;
  pid?: number;
  port?: number;
  startedAt?: string;
  exitCode?: number;
  logFile?: string;
}

export interface ServiceListResult {
  services: ServiceStatus[];
}

export interface ServiceStartResult {
  status: string;
  pid?: number;
  name: string;
  port?: number;
  logFile?: string;
  startedAt?: string;
}

export interface ServiceStopResult {
  status: string;
  name: string;
  pid?: number;
  message?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BatchExecResult {
  results: (ExecResult & { id: string })[];
}

export interface GitRepoStatus {
  path: string;
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  lastCommit: string | null;
  error?: string;
}

export interface GitStatus {
  repos: GitRepoStatus[];
}

export interface GitDiffFile {
  path: string;
  added: number;
  removed: number;
}

export interface GitDiffRepo {
  path: string;
  files: GitDiffFile[];
  totalAdded: number;
  totalRemoved: number;
  error?: string;
}

export interface GitDiffResult {
  repos: GitDiffRepo[];
}

export interface GitCommitResult {
  path: string;
  success: boolean;
  hash?: string;
  error?: string;
}

export interface GitPushResult {
  path: string;
  success: boolean;
  error?: string;
}

export interface DevCommandStatus {
  name: string;
  status: string;
  pid?: number;
  port?: number;
  startedAt?: string;
  exitCode?: number;
}

export interface DevCommandListResult {
  commands: DevCommandStatus[];
}

export interface DevStartResult {
  status: string;
  pid?: number;
  name: string;
  port?: number;
  logFile?: string;
  startedAt?: string;
}

export interface DevStopResult {
  status: string;
  name: string;
  pid?: number;
  message?: string;
  exitCode?: number;
}

export interface DevLogsResult {
  name: string;
  content: string;
  nextOffset: number;
}
