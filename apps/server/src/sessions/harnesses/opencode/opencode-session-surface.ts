/**
 * OpenCode's `HarnessSessionSurface` implementation, over `opencode serve`
 * REST. Ported verbatim from v1 `shared/agent/opencode-session-surface.ts`.
 * The SDK dependency lives here, at the edge of `sessions/` — the neutral
 * facade (`session.service.ts`) never imports `@opencode-ai/sdk` directly.
 */
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
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type {
  AgentConnection,
  CreateSessionResult,
  HarnessSessionSurface,
  InterventionResult,
} from "../../session-surface.ts";
import {
  createSandboxOpencodeClient,
  type SandboxOpencodeClient,
} from "./opencode-client.ts";
import { openOpencodeSession } from "./opencode-session.ts";
import { runOpencodeEventStream } from "./opencode-sse.ts";

const log = createChildLogger("opencode-session-surface");

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

export class OpencodeSessionSurface implements HarnessSessionSurface {
  private readonly client: SandboxOpencodeClient;

  constructor(conn: AgentConnection) {
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
    } catch (err) {
      log.warn({ sessionId, err }, "getSession failed");
      return null;
    }
  }

  async createSession(directory?: string): Promise<CreateSessionResult> {
    try {
      const session = await openOpencodeSession(this.client, { directory });
      return { sessionId: session.id, directory: session.directory };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Unknown error" };
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      const { data } = await this.client.session.delete({
        sessionID: sessionId,
      });
      return data ?? false;
    } catch (err) {
      log.warn({ sessionId, err }, "deleteSession failed");
      return false;
    }
  }

  async abortSession(sessionId: string): Promise<boolean> {
    try {
      const { data } = await this.client.session.abort({
        sessionID: sessionId,
      });
      return data ?? false;
    } catch (err) {
      log.warn({ sessionId, err }, "abortSession failed");
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
    } catch (err) {
      log.warn({ requestId, err }, "replyPermission failed");
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
    } catch (err) {
      log.warn({ requestId, err }, "replyQuestion failed");
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
    } catch (err) {
      log.warn({ requestId, err }, "rejectQuestion failed");
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
      getClient: () => this.client,
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
