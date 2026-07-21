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

/** A file entry as it appears in `SandboxSpec`/`PatchFilesRequest` — `content`
 * is typed `unknown` here because `SandboxSpec.files[].content` is
 * `MaybeSecretString` at the type level, but by the time a spec reaches the
 * agent client secrets are already resolved to plain strings (the seam
 * rejects any unresolved ref). `owner` is an unvalidated string from the wire
 * schema, narrowed to the agent's `"dev" | "root"` union below. */
interface WireFileEntry {
  path: string;
  content: unknown;
  mode?: string;
  owner?: string;
}

/** Project a spec/request file list onto the agent's `FileWrite` shape.
 * Shared by every `files/write` call site so the `content`/`owner` casts live
 * in exactly one place. */
export function toFileWrites(files: WireFileEntry[]): FileWrite[] {
  return files.map((f) => ({
    path: f.path,
    content: f.content as string,
    mode: f.mode,
    owner: f.owner as "dev" | "root" | undefined,
  }));
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
