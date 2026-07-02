/**
 * The dashboard/CLI-facing agent session facade. Reshaped from v1
 * `api/sandboxes/agent-facade.routes.ts`'s `surfaceFor()` + handlers: the
 * routing/Elysia concerns move to `api/`, this class is the framework-agnostic
 * mechanism. Harness-neutral — `SessionSurfaceResolver` is the injection
 * point v1's inline `new OpencodeSessionSurface(...)` used to be; the server
 * bootstrap supplies the concrete resolver (today: opencode only, via
 * `@atelier/compose`).
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
import { NotFoundError } from "../shared/errors.ts";
import type {
  CreateSessionResult,
  HarnessSessionSurface,
  InterventionResult,
} from "./session-surface.ts";

export interface SessionSurfaceResolver {
  /** ACP goes over the runtime attach bridge, so a surface needs only the
   * sandbox id (v1's `AgentConnection {ipAddress,password}` is dead). */
  resolve(sandboxId: string, harnessId?: string): HarnessSessionSurface;
}

export class SessionService {
  constructor(
    private readonly deps: {
      runtime: RuntimeService;
      surfaces: SessionSurfaceResolver;
    },
  ) {}

  private async surfaceFor(sandboxId: string): Promise<HarnessSessionSurface> {
    // Fetch state only to read the harness annotation (which surface to use);
    // the surface reaches the sandbox over the runtime attach bridge, not a
    // pod IP. Throws NotFound for an unknown sandbox, same as any op.
    const state = await this.deps.runtime.get(sandboxId);
    const harnessId = state.annotations?.["atelier.dev/harness"];
    return this.deps.surfaces.resolve(sandboxId, harnessId);
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
