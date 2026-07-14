/**
 * Terminal (PTY) session mechanism — ownership-checked CRUD plus the raw byte
 * bridge URL. The ownership checks and agent calls are framework-agnostic
 * here; the actual Elysia `.ws()` byte relay lives in `api/` (WS glue is
 * inherently framework-specific and stays thin there).
 */
import type { AgentClient, TerminalSession } from "../runtime/index.ts";
import { ForbiddenError, NotFoundError } from "../shared/errors.ts";
import { config } from "../shared/lib/config.ts";

export class TerminalService {
  constructor(private readonly deps: { agent: AgentClient }) {}

  async listSessions(
    sandboxId: string,
    userId: string,
  ): Promise<TerminalSession[]> {
    const sessions = await this.deps.agent.terminalSessionList(sandboxId);
    return sessions.filter((s) => s.userId === userId);
  }

  async createSession(
    sandboxId: string,
    userId: string,
    options?: { title?: string; command?: string; workdir?: string },
  ) {
    return this.deps.agent.terminalSessionCreate(sandboxId, userId, options);
  }

  /** Throws NotFound / Forbidden — never returns another user's session. */
  async getOwnedSession(
    sandboxId: string,
    sessionId: string,
    userId: string,
  ): Promise<TerminalSession> {
    let session: TerminalSession;
    try {
      session = await this.deps.agent.terminalSessionGet(sandboxId, sessionId);
    } catch {
      throw new NotFoundError("Terminal session", sessionId);
    }
    if (session.userId !== userId) {
      throw new ForbiddenError("Access denied");
    }
    return session;
  }

  async deleteSession(
    sandboxId: string,
    sessionId: string,
    userId: string,
  ): Promise<void> {
    await this.getOwnedSession(sandboxId, sessionId, userId);
    await this.deps.agent.terminalSessionDelete(sandboxId, sessionId);
  }

  /** Raw WS URL for the pod's terminal multiplexer — byte relay, no ACP. */
  async bridgeUrl(sandboxId: string, sessionId: string): Promise<string> {
    const ip = await this.deps.agent.getPodIp(sandboxId);
    return `ws://${ip}:${config.ports.terminal}/${sessionId}`;
  }
}
