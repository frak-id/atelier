/**
 * The console-facing agent session API for a sandbox: a thin, stateless view
 * over the ACP hub ({@link AgentDispatch}), which owns all live state
 * (connection, live overlay, event emitter). The Elysia binding lives in
 * `api/sessions.routes.ts`.
 *
 * Harness-neutral: every harness speaks ACP over the attach bridge (the `acp`
 * process convention), so a sandbox only needs the `atelier.dev/harness`
 * annotation. A sandbox without it has no agent and gets a clean error. ACP
 * has no session hierarchy, so `parentID` is always absent.
 */
import type {
  AgentEvent,
  AgentSession,
  AgentSessionStatus,
  AgentTodo,
} from "@atelier/spec";
import type { RuntimeService } from "../runtime/index.ts";
import { ConflictError, NotFoundError } from "../shared/errors.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { AgentDispatch, SessionMeta } from "./acp/agent-dispatch.ts";

const log = createChildLogger("session-service");

const HARNESS_ANNOTATION = "atelier.dev/harness";

export class SessionService {
  constructor(
    private readonly deps: {
      runtime: Pick<RuntimeService, "getLabels">;
      dispatch: Pick<
        AgentDispatch,
        | "sessionsFor"
        | "sessionFor"
        | "statusesFor"
        | "todosFor"
        | "closeSession"
        | "abortSession"
        | "subscribe"
      >;
    },
  ) {}

  /** Check the sandbox has an agent at all: a store read of its harness
   * annotation, no agent round-trip (the console polls these routes). */
  private requireHarness(sandboxId: string): void {
    const labels = this.deps.runtime.getLabels(sandboxId);
    if (!labels) throw new NotFoundError("Sandbox", sandboxId);
    if (!labels.annotations[HARNESS_ANNOTATION]) {
      throw new ConflictError(
        `Sandbox ${sandboxId} has no agent harness (no ${HARNESS_ANNOTATION} annotation); agent sessions are unavailable`,
      );
    }
  }

  async listSessions(sandboxId: string): Promise<AgentSession[]> {
    this.requireHarness(sandboxId);
    // Reads dial `session/list`; a transient ACP disruption degrades to an
    // empty list rather than 500ing the dashboard poll into a retry storm.
    try {
      const sessions = await this.deps.dispatch.sessionsFor(sandboxId);
      return sessions.map((meta) => toSession(sandboxId, meta));
    } catch (err) {
      log.warn({ sandboxId, err }, "listSessions failed");
      return [];
    }
  }

  async getSession(
    sandboxId: string,
    sessionId: string,
  ): Promise<AgentSession> {
    this.requireHarness(sandboxId);
    let meta: SessionMeta | undefined;
    try {
      meta = await this.deps.dispatch.sessionFor(sandboxId, sessionId);
    } catch (err) {
      log.warn({ sandboxId, err }, "getSession failed");
    }
    if (!meta) throw new NotFoundError("Session", sessionId);
    return toSession(sandboxId, meta);
  }

  async deleteSession(sandboxId: string, sessionId: string): Promise<boolean> {
    this.requireHarness(sandboxId);
    return this.deps.dispatch.closeSession(sandboxId, sessionId);
  }

  async abortSession(sandboxId: string, sessionId: string): Promise<boolean> {
    this.requireHarness(sandboxId);
    return this.deps.dispatch.abortSession(sandboxId, sessionId);
  }

  async getTodos(sandboxId: string, sessionId: string): Promise<AgentTodo[]> {
    this.requireHarness(sandboxId);
    return this.deps.dispatch.todosFor(sandboxId, sessionId);
  }

  async sessionStatuses(
    sandboxId: string,
  ): Promise<Record<string, AgentSessionStatus>> {
    this.requireHarness(sandboxId);
    try {
      return await this.deps.dispatch.statusesFor(sandboxId);
    } catch (err) {
      log.warn({ sandboxId, err }, "sessionStatuses failed");
      return {};
    }
  }

  /** Forward the hub's coarse invalidation signals until `signal` aborts.
   * Watching is free: it never opens or holds the ACP socket. */
  async subscribeEvents(
    sandboxId: string,
    signal: AbortSignal,
    onEvent: (event: Omit<AgentEvent, "sandboxId">) => void,
  ): Promise<void> {
    this.requireHarness(sandboxId);
    if (signal.aborted) return;
    const unsubscribe = this.deps.dispatch.subscribe(sandboxId, onEvent);
    try {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally {
      unsubscribe();
    }
  }
}

function toSession(sandboxId: string, meta: SessionMeta): AgentSession {
  return {
    sandboxId,
    id: meta.sessionId,
    title: meta.title,
    directory: meta.directory,
    time: { created: meta.created, updated: meta.updated },
  };
}
