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

/** A supervised process's state (v2 agent `GET /processes` / `/processes/{name}`).
 * Mirrors agent-v2 `supervisor::ProcessState`. */
export interface AgentProcessState {
  name: string;
  status: "starting" | "running" | "stopped" | "error";
  pid: number;
  ready: boolean;
  primary: boolean;
  exitCode?: number;
  startedAt: string;
  logFile: string;
}

export interface AgentProcessListResult {
  processes: AgentProcessState[];
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

export interface TerminalSessionDeleteResult {
  success: boolean;
}
