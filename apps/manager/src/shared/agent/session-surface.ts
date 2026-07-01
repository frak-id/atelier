import type {
  AgentEvent,
  AgentPermissionReply,
  AgentPermissionRequest,
  AgentQuestionRequest,
  AgentSession,
  AgentSessionStatus,
  AgentTodo,
} from "@frak/atelier-shared";

/** How the manager reaches a sandbox's coding agent (resolved server-side). */
export interface AgentConnection {
  ipAddress: string;
  password?: string;
}

export type CreateSessionResult =
  | { sessionId: string; directory: string }
  | { error: string };

/** Outcome of an intervention reply; `status` carries the upstream HTTP status
 * (e.g. 404 "expired") so the facade/dashboard can special-case it. */
export interface InterventionResult {
  ok: boolean;
  status?: number;
}

/**
 * The dashboard's read/intervene session surface for ONE sandbox, provided per
 * harness adapter. opencode implements it over `opencode serve` REST (full
 * fidelity: hierarchy, questions); a future ACP-only harness would implement a
 * flat subset over an ACP session store (no hierarchy/questions).
 *
 * Methods return neutral `Agent*` shapes WITHOUT `sandboxId` — the facade
 * injects it. Session ids are neutral (`sessionId`).
 */
export interface HarnessSessionSurface {
  listSessions(): Promise<Omit<AgentSession, "sandboxId">[]>;
  getSession(
    sessionId: string,
  ): Promise<Omit<AgentSession, "sandboxId"> | null>;
  createSession(directory?: string): Promise<CreateSessionResult>;
  deleteSession(sessionId: string): Promise<boolean>;
  abortSession(sessionId: string): Promise<boolean>;
  sessionStatuses(): Promise<Record<string, AgentSessionStatus>>;
  getTodos(sessionId: string): Promise<AgentTodo[]>;
  listPermissions(): Promise<AgentPermissionRequest[]>;
  replyPermission(
    requestId: string,
    reply: AgentPermissionReply,
  ): Promise<InterventionResult>;
  listQuestions(): Promise<AgentQuestionRequest[]>;
  replyQuestion(
    requestId: string,
    answers: string[][],
  ): Promise<InterventionResult>;
  rejectQuestion(requestId: string): Promise<InterventionResult>;
  /**
   * Stream change signals until `signal` aborts. Invokes `onEvent` with neutral
   * events (without `sandboxId`, which the facade adds when fanning out).
   */
  subscribeEvents(
    signal: AbortSignal,
    onEvent: (event: Omit<AgentEvent, "sandboxId">) => void,
  ): Promise<void>;
}

/** Builds a session surface for a resolved sandbox connection. */
export type HarnessSessionSurfaceFactory = (
  conn: AgentConnection,
) => HarnessSessionSurface;
