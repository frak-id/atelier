/**
 * The dashboard/CLI-facing agent session facade. Reshaped from v1
 * `api/sandboxes/agent-facade.routes.ts`'s `surfaceFor()` + handlers: the
 * routing/Elysia concerns move to `api/`, this class is the framework-agnostic
 * mechanism. Harness-neutral: every harness speaks ACP over the attach bridge
 * (the `acp` process convention), so ONE surface factory serves all of them —
 * a sandbox only needs the `atelier.dev/harness` annotation, no per-harness
 * server registration. A sandbox without the annotation has no agent surface
 * and gets a clean error instead of a silently-wrong default.
 *
 * A privileged CLIENT of runtime (atelier-v2 §3.1): resolves connection info
 * via `RuntimeService.get()`, same data any API caller could read.
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
import type { RuntimeService } from "../runtime/index.ts";
import { ConflictError, NotFoundError } from "../shared/errors.ts";
import type {
  CreateSessionResult,
  HarnessSessionSurface,
  InterventionResult,
} from "./session-surface.ts";

export class SessionService {
  constructor(
    private readonly deps: {
      runtime: RuntimeService;
      /** ACP goes over the runtime attach bridge, so a surface needs only
       * the sandbox id (v1's `AgentConnection {ipAddress,password}` is
       * dead). One factory for every harness — they all speak ACP. */
      surface: (sandboxId: string) => HarnessSessionSurface;
    },
  ) {}

  private async surfaceFor(sandboxId: string): Promise<HarnessSessionSurface> {
    // Fetch state only to check the harness annotation (does this sandbox
    // have an agent at all?); the surface reaches the sandbox over the
    // runtime attach bridge, not a pod IP. Throws NotFound for an unknown
    // sandbox, same as any op.
    const state = await this.deps.runtime.get(sandboxId);
    if (!state.annotations?.["atelier.dev/harness"]) {
      throw new ConflictError(
        `Sandbox ${sandboxId} has no agent harness (no atelier.dev/harness annotation); agent sessions are unavailable`,
      );
    }
    return this.deps.surface(sandboxId);
  }

  async listSessions(sandboxId: string): Promise<AgentSession[]> {
    const sessions = await (await this.surfaceFor(sandboxId)).listSessions();
    return sessions.map((s) => ({ ...s, sandboxId }));
  }

  async getSession(
    sandboxId: string,
    sessionId: string,
  ): Promise<AgentSession> {
    const session = await (await this.surfaceFor(sandboxId)).getSession(
      sessionId,
    );
    if (!session) throw new NotFoundError("Session", sessionId);
    return { ...session, sandboxId };
  }

  async createSession(
    sandboxId: string,
    directory?: string,
  ): Promise<CreateSessionResult> {
    return (await this.surfaceFor(sandboxId)).createSession(directory);
  }

  async deleteSession(sandboxId: string, sessionId: string): Promise<boolean> {
    return (await this.surfaceFor(sandboxId)).deleteSession(sessionId);
  }

  async abortSession(sandboxId: string, sessionId: string): Promise<boolean> {
    return (await this.surfaceFor(sandboxId)).abortSession(sessionId);
  }

  async getTodos(sandboxId: string, sessionId: string): Promise<AgentTodo[]> {
    return (await this.surfaceFor(sandboxId)).getTodos(sessionId);
  }

  async sessionStatuses(
    sandboxId: string,
  ): Promise<Record<string, AgentSessionStatus>> {
    return (await this.surfaceFor(sandboxId)).sessionStatuses();
  }

  async listPermissions(sandboxId: string): Promise<AgentPermissionRequest[]> {
    return (await this.surfaceFor(sandboxId)).listPermissions();
  }

  async replyPermission(
    sandboxId: string,
    requestId: string,
    reply: AgentPermissionReply,
  ): Promise<InterventionResult> {
    const result = await (await this.surfaceFor(sandboxId)).replyPermission(
      requestId,
      reply,
    );
    if (!result.ok && result.status === 404) {
      throw new NotFoundError("Permission request", requestId);
    }
    return result;
  }

  async listQuestions(sandboxId: string): Promise<AgentQuestionRequest[]> {
    return (await this.surfaceFor(sandboxId)).listQuestions();
  }

  async replyQuestion(
    sandboxId: string,
    requestId: string,
    answers: string[][],
  ): Promise<InterventionResult> {
    const result = await (await this.surfaceFor(sandboxId)).replyQuestion(
      requestId,
      answers,
    );
    if (!result.ok && result.status === 404) {
      throw new NotFoundError("Question", requestId);
    }
    return result;
  }

  async rejectQuestion(
    sandboxId: string,
    requestId: string,
  ): Promise<InterventionResult> {
    const result = await (await this.surfaceFor(sandboxId)).rejectQuestion(
      requestId,
    );
    if (!result.ok && result.status === 404) {
      throw new NotFoundError("Question", requestId);
    }
    return result;
  }

  /** Stream neutral agent events for a sandbox until `signal` aborts. */
  async subscribeEvents(
    sandboxId: string,
    signal: AbortSignal,
    onEvent: (event: Omit<AgentEvent, "sandboxId">) => void,
  ): Promise<void> {
    const surface = await this.surfaceFor(sandboxId);
    return surface.subscribeEvents(signal, onEvent);
  }
}
