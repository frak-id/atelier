/**
 * The v2 `HarnessSessionSurface` — a STATELESS per-sandbox view over the ACP
 * hub ({@link AgentDispatch}). Replaces v1's `OpencodeSessionSurface`, which
 * spoke `opencode serve` REST over HTTP: v2 harnesses run as an `acp` stdio
 * bridge (no serve port), so the dashboard's read/intervene surface is served
 * from the same shared ACP connection the chat flow uses.
 *
 * Every method delegates to the hub; the hub owns all state (session registry,
 * permission buffer, event emitter). ACP is a flatter model than opencode
 * serve, so two capabilities degrade by design (the neutral schema was built
 * for this): no session hierarchy (`parentID` always absent) and no separate
 * "questions" concept (only permissions) — `listQuestions()` is empty and
 * question replies 404.
 */
import type {
  AgentEvent,
  AgentPermissionReply,
  AgentPermissionRequest,
  AgentQuestionRequest,
  AgentSession,
  AgentSessionStatus,
  AgentTodo,
} from "@frak/atelier-shared";
import { VM } from "@frak/atelier-shared/constants";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type {
  CreateSessionResult,
  HarnessSessionSurface,
  InterventionResult,
} from "../session-surface.ts";
import type { AgentDispatch, SessionMeta } from "./agent-dispatch.ts";

const log = createChildLogger("acp-session-surface");

const QUESTIONS_UNSUPPORTED: InterventionResult = { ok: false, status: 404 };

function metaToSession(meta: SessionMeta): Omit<AgentSession, "sandboxId"> {
  return {
    id: meta.sessionId,
    title: meta.title,
    directory: meta.directory,
    time: { created: meta.created, updated: meta.updated },
  };
}

export class AcpSessionSurface implements HarnessSessionSurface {
  constructor(
    private readonly dispatch: AgentDispatch,
    private readonly sandboxId: string,
  ) {}

  async listSessions(): Promise<Omit<AgentSession, "sandboxId">[]> {
    // Reads now dial `session/list`; a transient ACP disruption must degrade to
    // an empty list (as the old lazy no-dial read did), not 500 the dashboard
    // poll into a react-query retry storm.
    try {
      const sessions = await this.dispatch.sessionsFor(this.sandboxId);
      return sessions.map(metaToSession);
    } catch (err) {
      log.warn({ sandboxId: this.sandboxId, err }, "listSessions failed");
      return [];
    }
  }

  async getSession(
    sessionId: string,
  ): Promise<Omit<AgentSession, "sandboxId"> | null> {
    try {
      const meta = await this.dispatch.sessionFor(this.sandboxId, sessionId);
      return meta ? metaToSession(meta) : null;
    } catch (err) {
      log.warn({ sandboxId: this.sandboxId, err }, "getSession failed");
      return null;
    }
  }

  async createSession(directory?: string): Promise<CreateSessionResult> {
    try {
      return await this.dispatch.createSession(
        this.sandboxId,
        directory ?? VM.HOME,
      );
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.dispatch.closeSession(this.sandboxId, sessionId);
  }

  async abortSession(sessionId: string): Promise<boolean> {
    return this.dispatch.abortSession(this.sandboxId, sessionId);
  }

  async sessionStatuses(): Promise<Record<string, AgentSessionStatus>> {
    try {
      return await this.dispatch.statusesFor(this.sandboxId);
    } catch (err) {
      log.warn({ sandboxId: this.sandboxId, err }, "sessionStatuses failed");
      return {};
    }
  }

  async getTodos(sessionId: string): Promise<AgentTodo[]> {
    return this.dispatch.todosFor(this.sandboxId, sessionId);
  }

  async listPermissions(): Promise<AgentPermissionRequest[]> {
    return this.dispatch.permissionsFor(this.sandboxId);
  }

  async replyPermission(
    requestId: string,
    reply: AgentPermissionReply,
  ): Promise<InterventionResult> {
    return this.dispatch.replyPermission(this.sandboxId, requestId, reply);
  }

  // ── questions: unsupported over ACP (no serve question bus) ────────────────

  async listQuestions(): Promise<AgentQuestionRequest[]> {
    return [];
  }

  async replyQuestion(): Promise<InterventionResult> {
    return QUESTIONS_UNSUPPORTED;
  }

  async rejectQuestion(): Promise<InterventionResult> {
    return QUESTIONS_UNSUPPORTED;
  }

  /**
   * Fan the hub's coarse invalidation signals out to the facade SSE stream
   * until `signal` aborts. `SurfaceEvent` is structurally `Omit<AgentEvent,
   * "sandboxId">` (its resource union is a subset), so it forwards directly.
   * Watching is free — it never opens/holds the ACP socket.
   */
  async subscribeEvents(
    signal: AbortSignal,
    onEvent: (event: Omit<AgentEvent, "sandboxId">) => void,
  ): Promise<void> {
    if (signal.aborted) return;
    const unsubscribe = this.dispatch.subscribe(this.sandboxId, onEvent);
    try {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      unsubscribe();
    }
  }
}
