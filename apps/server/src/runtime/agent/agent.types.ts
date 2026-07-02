export interface AgentHealth {
  status: string;
  sandboxId?: string;
  uptime: number;
  /** Whether a config has been pushed (v2 agent). */
  configured?: boolean;
  /** Whether the spec's `primary` process is ready — the sandbox health gate
   * (v2 agent). True when there is no primary (liveness == health). */
  healthy?: boolean;
}

/** One hook command's outcome (v2 agent `POST /hooks/{phase}`). */
export interface HookResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Result of running a lifecycle phase's hooks in order (v2 agent). */
export interface HookPhaseResult {
  success: boolean;
  results: HookResult[];
}

/** A lifecycle phase the runtime drives on the v2 agent. */
export type HookPhase = "postCreate" | "postStart" | "onResume" | "envChanged";

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

export interface Command {
  id: string;
  command: string;
  timeout?: number;
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

export interface DevLogsResult {
  name: string;
  content: string;
  nextOffset: number;
}

export interface FileWrite {
  path: string;
  content: string;
  mode?: string;
  owner?: "dev" | "root";
}

export interface FileWriteResult {
  path: string;
  success: boolean;
  error?: string;
}

export interface WriteFilesResult {
  results: FileWriteResult[];
}

export interface TerminalSession {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
}

export interface TerminalSessionCreateResult extends TerminalSession {}

export interface TerminalSessionListResult extends Array<TerminalSession> {}

export interface TerminalSessionDeleteResult {
  success: boolean;
}

/** A harness subprocess spawned by the in-pod ACP bridge (agent-rust/acp.rs). */
export interface AcpBridgeSession {
  id: string;
  pid: number;
  createdAt: string;
}

export interface AcpBridgeSessionDeleteResult {
  success: boolean;
}

/** Per-session harness launch overrides for the ACP bridge (all optional; each
 * falls back to the pod's `acp` service config when omitted). */
export interface AcpBridgeSessionSpec {
  command?: string;
  workdir?: string;
  user?: string;
  env?: Record<string, string>;
}
