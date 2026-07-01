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
  AgentConnection,
  CreateSessionResult,
  HarnessSessionSurface,
  InterventionResult,
} from "./session-surface.ts";

export interface SessionSurfaceResolver {
  resolve(conn: AgentConnection, harnessId?: string): HarnessSessionSurface;
}

export class SessionService {
  constructor(
    private readonly deps: {
      runtime: RuntimeService;
      surfaces: SessionSurfaceResolver;
    },
  ) {}

  private async surfaceFor(sandboxId: string): Promise<HarnessSessionSurface> {
    const state = await this.deps.runtime.get(sandboxId);
    const conn: AgentConnection = {
      ipAddress: state.generated?.podIp ?? "",
      password: state.generated?.agentPassword,
    };
    const harnessId = state.annotations?.["atelier.dev/harness"];
    return this.deps.surfaces.resolve(conn, harnessId);
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
