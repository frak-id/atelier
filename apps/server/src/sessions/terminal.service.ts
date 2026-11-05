/**
 * Terminal (PTY) session mechanism — ownership-checked CRUD plus the raw byte
 * bridge URL. The ownership checks and agent calls are framework-agnostic
 * here; the actual Elysia `.ws()` byte relay lives in `api/` (WS glue is
 * inherently framework-specific and stays thin there).
 */
import type { AgentClient, TerminalSession } from "../runtime/index.ts";
import { ForbiddenError, NotFoundError } from "../shared/errors.ts";

/**
 * What the console's terminal supports, for programs that can't tell from
 * `TERM` alone. Sessions are rendered by the console's xterm.js
 * (apps/console/src/components/terminal-view.tsx), so these describe it
 * exactly. The agent knows nothing about its client: they go in as the
 * session's env, and the sandbox's own env can still override them.
 */
const CONSOLE_TERMINAL_ENV: Record<string, string> = {
  // xterm.js renders 24-bit SGR colour; without this hint truecolor-aware
  // programs (pi, bat, delta, neovim, ...) fall back to the 256 palette.
  COLORTERM: "truecolor",
  // pi turns these on only for terminals it recognises by name. xterm.js
  // handles OSC 8 hyperlinks natively, and iTerm2 inline images through
  // @xterm/addon-image (which has no Kitty graphics support).
  PI_HYPERLINKS: "1",
  PI_IMAGE_PROTOCOL: "iterm2",
};

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
    return this.deps.agent.terminalSessionCreate(sandboxId, userId, {
      ...options,
      env: CONSOLE_TERMINAL_ENV,
    });
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
    return this.deps.agent.terminalBridgeUrl(sandboxId, sessionId);
  }
}
