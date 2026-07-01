import type {
  AgentPermissionReply,
  AgentPermissionRequest,
  AgentQuestionRequest,
  AgentSession,
  AgentSessionStatus,
  AgentTodo,
} from "@frak/atelier-shared";
import type {
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2";
import {
  createSandboxOpencodeClient,
  type SandboxOpencodeClient,
} from "../lib/opencode-client.ts";
import { runOpencodeEventStream } from "../lib/opencode-sse.ts";
import type {
  AgentConnection,
  CreateSessionResult,
  HarnessSessionSurface,
  InterventionResult,
} from "./session-surface.ts";

// --- SDK -> neutral mappers ---

function toAgentSession(s: Session): Omit<AgentSession, "sandboxId"> {
  return {
    id: s.id,
    ...(s.parentID && { parentID: s.parentID }),
    title: s.title,
    directory: s.directory,
    time: {
      created: s.time.created,
      updated: s.time.updated ?? s.time.created,
    },
  };
}

function toAgentStatus(s: SessionStatus): AgentSessionStatus {
  if (s.type === "retry") {
    return {
      type: "retry",
      attempt: s.attempt,
      message: s.message,
      next: s.next,
    };
  }
  return { type: s.type };
}

function toAgentTodo(t: Todo): AgentTodo {
  return {
    content: t.content,
    status: t.status as AgentTodo["status"],
    ...(t.priority && { priority: t.priority }),
  };
}

function toAgentPermission(p: PermissionRequest): AgentPermissionRequest {
  return {
    id: p.id,
    sessionId: p.sessionID,
    permission: p.permission,
    patterns: p.patterns,
    metadata: p.metadata,
    always: p.always,
  };
}

function toAgentQuestion(q: QuestionRequest): AgentQuestionRequest {
  return {
    id: q.id,
    sessionId: q.sessionID,
    questions: q.questions.map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options.map((o) => ({
        label: o.label,
        description: o.description,
      })),
      ...(question.multiple !== undefined && { multiple: question.multiple }),
      ...(question.custom !== undefined && { custom: question.custom }),
    })),
  };
}

const SESSION_READY_TIMEOUT_MS = 10_000;
const SESSION_READY_INITIAL_DELAY_MS = 25;
const SESSION_READY_MAX_DELAY_MS = 200;

/** OpenCode's session surface, over `opencode serve` REST. SDK lives here. */
export class OpencodeSessionSurface implements HarnessSessionSurface {
  private readonly client: SandboxOpencodeClient;

  constructor(private readonly conn: AgentConnection) {
    this.client = createSandboxOpencodeClient(conn.ipAddress, conn.password);
  }

  async listSessions(): Promise<Omit<AgentSession, "sandboxId">[]> {
    const { data } = await this.client.session.list();
    return (data ?? []).map(toAgentSession);
  }

  async getSession(
    sessionId: string,
  ): Promise<Omit<AgentSession, "sandboxId"> | null> {
    try {
      const { data, error } = await this.client.session.get({
        sessionID: sessionId,
      });
      return data?.id && !error ? toAgentSession(data) : null;
    } catch {
      return null;
    }
  }

  async createSession(directory?: string): Promise<CreateSessionResult> {
    try {
      const { data, error } = await this.client.session.create({ directory });
      if (error || !data?.id || !data?.directory) {
        return { error: "Failed to create session" };
      }
      await this.waitForSessionReady(data.id);
      return { sessionId: data.id, directory: data.directory };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Unknown error" };
    }
  }

  private async waitForSessionReady(sessionId: string): Promise<void> {
    const deadline = Date.now() + SESSION_READY_TIMEOUT_MS;
    let delay = SESSION_READY_INITIAL_DELAY_MS;
    while (Date.now() < deadline) {
      try {
        const { data, error } = await this.client.session.get({
          sessionID: sessionId,
        });
        if (data?.id && !error) return;
      } catch {
        // retry until deadline
      }
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, SESSION_READY_MAX_DELAY_MS);
    }
    throw new Error(`Session ${sessionId} did not become ready`);
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      const { data } = await this.client.session.delete({
        sessionID: sessionId,
      });
      return data ?? false;
    } catch {
      return false;
    }
  }

  async abortSession(sessionId: string): Promise<boolean> {
    try {
      const { data } = await this.client.session.abort({
        sessionID: sessionId,
      });
      return data ?? false;
    } catch {
      return false;
    }
  }

  async sessionStatuses(): Promise<Record<string, AgentSessionStatus>> {
    const { data } = await this.client.session.status();
    const out: Record<string, AgentSessionStatus> = {};
    for (const [id, status] of Object.entries(
      (data as Record<string, SessionStatus>) ?? {},
    )) {
      out[id] = toAgentStatus(status);
    }
    return out;
  }

  async getTodos(sessionId: string): Promise<AgentTodo[]> {
    const { data } = await this.client.session.todo({ sessionID: sessionId });
    return (data ?? []).map(toAgentTodo);
  }

  async listPermissions(): Promise<AgentPermissionRequest[]> {
    const { data } = await this.client.permission.list();
    return (data ?? []).map(toAgentPermission);
  }

  async replyPermission(
    requestId: string,
    reply: AgentPermissionReply,
  ): Promise<InterventionResult> {
    try {
      const { data, error, response } = await this.client.permission.reply({
        requestID: requestId,
        reply,
      });
      if (error) return { ok: false, status: response?.status };
      return { ok: data ?? false };
    } catch {
      return { ok: false };
    }
  }

  async listQuestions(): Promise<AgentQuestionRequest[]> {
    const { data } = await this.client.question.list();
    return (data ?? []).map(toAgentQuestion);
  }

  async replyQuestion(
    requestId: string,
    answers: string[][],
  ): Promise<InterventionResult> {
    try {
      const { data, error, response } = await this.client.question.reply({
        requestID: requestId,
        answers,
      });
      if (error) return { ok: false, status: response?.status };
      return { ok: data ?? false };
    } catch {
      return { ok: false };
    }
  }

  async rejectQuestion(requestId: string): Promise<InterventionResult> {
    try {
      const { data, error, response } = await this.client.question.reject({
        requestID: requestId,
      });
      if (error) return { ok: false, status: response?.status };
      return { ok: data ?? false };
    } catch {
      return { ok: false };
    }
  }

  async subscribeEvents(
    signal: AbortSignal,
    onEvent: (event: {
      resource:
        | "sessions"
        | "sessionStatuses"
        | "permissions"
        | "questions"
        | "todos";
      sessionId?: string;
    }) => void,
  ): Promise<void> {
    await runOpencodeEventStream({
      signal,
      getClient: () =>
        createSandboxOpencodeClient(this.conn.ipAddress, this.conn.password),
      onEvent: (event) => {
        const mapped = mapEvent(event);
        if (mapped) onEvent(mapped);
      },
    });
  }
}

/** Collapse opencode's SSE event taxonomy onto neutral resource kinds. */
function mapEvent(event: {
  type?: string;
  properties?: Record<string, unknown>;
}): {
  resource:
    | "sessions"
    | "sessionStatuses"
    | "permissions"
    | "questions"
    | "todos";
  sessionId?: string;
} | null {
  const type = event.type ?? "";
  const rawSessionId = event.properties?.sessionID;
  const sessionId = typeof rawSessionId === "string" ? rawSessionId : undefined;
  // Explicit allowlist: opencode streams high-frequency `session.next.*` token
  // deltas we must NOT fan out (they'd invalidate the session list per token).
  if (type === "session.status" || type === "session.idle") {
    return { resource: "sessionStatuses" };
  }
  if (
    type === "session.created" ||
    type === "session.updated" ||
    type === "session.deleted"
  ) {
    return { resource: "sessions" };
  }
  if (type === "permission.asked" || type === "permission.replied") {
    return { resource: "permissions" };
  }
  if (
    type === "question.asked" ||
    type === "question.replied" ||
    type === "question.rejected"
  ) {
    return { resource: "questions" };
  }
  if (type === "todo.updated") return { resource: "todos", sessionId };
  return null;
}
