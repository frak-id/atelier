/**
 * Agent-neutral ACP client (atelier-v2 §3.1 "sessions/"). Speaks ACP JSON-RPC
 * to a sandbox's harness by **attaching to the already-supervised `acp`
 * process** through the runtime's unified attach bridge (agent-v2 attach.rs on
 * :9997) — not by spawning a per-session bridge subprocess. The `acp` process
 * is declared in the spec (`stdio: "bridge"`, `primary: true`, composed
 * client-side by `@atelier/compose`); the runtime boots it once and gates
 * health on it, so by the time a session opens it is already running.
 *
 * The attach bridge is single-writer, so all ACP sessions for one sandbox
 * share ONE rw attach connection ({@link SandboxAcpConnection}) and are
 * multiplexed by ACP `sessionId`. sessions/ is a privileged CLIENT of the
 * runtime API here — attach + files, the same surface any caller could use.
 */
import {
  type ClientConnection,
  client,
  type McpServer,
  methods,
  PROTOCOL_VERSION,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AgentClient } from "../../runtime/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { type AcpTransport, connectAcpWebSocket } from "./acp-stream.ts";
import {
  type AgentModelSelection,
  type HarnessDispatchAdapter,
  resolveHarnessDispatch,
} from "./harness-registry.ts";

const log = createChildLogger("agent-dispatch");

/** See v1 rationale: bounds handshake calls only, never `session/prompt`. */
const ACP_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * The supervised process that carries the ACP bridge. Convention from the
 * harness composers (`@atelier/compose`): the harness emits a `stdio: "bridge"`
 * primary process named `acp`. sessions/ attaches to it by name.
 */
const ACP_PROCESS_NAME = "acp";

export interface AgentSessionCallbacks {
  onUpdate?: (notification: SessionNotification) => void;
  onPermission?: (
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
}

export interface OpenAgentSessionInput {
  sandboxId: string;
  /** Absolute working directory for the session. */
  cwd: string;
  /** Harness dispatch id, from the spec's `atelier.dev/harness` annotation. */
  harnessId?: string;
  mcpServers?: McpServer[];
  callbacks?: AgentSessionCallbacks;
}

export interface AgentSession {
  readonly sessionId: string;
  readonly sandboxId: string;
  prompt(
    text: string,
    selection?: AgentModelSelection,
  ): Promise<PromptResponse>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

/** Reject `op` if it doesn't settle within `ms` (does not tear the shared
 * connection down — a slow handshake shouldn't kill sibling sessions). */
async function withTimeout<T>(
  op: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`ACP ${label} timed out after ${ms}ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([op, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

type AgentProxy = ClientConnection["agent"];

/**
 * One shared ACP connection to a sandbox's `acp` process. Owns the single rw
 * attach WebSocket + ACP client connection, routes `session/update` and
 * `session/requestPermission` to the right session's callbacks by `sessionId`,
 * and refcounts live sessions so the socket closes when the last one does.
 */
class SandboxAcpConnection {
  private readonly handlers = new Map<string, AgentSessionCallbacks>();
  private closed = false;
  /** Whether the agent advertised `sessionCapabilities.close` at initialize —
   * gates whether `session.close()` sends `session/close` (below). */
  canCloseSession = false;

  private constructor(
    private readonly transport: AcpTransport,
    private readonly connection: ClientConnection,
    readonly acp: AgentProxy,
    private readonly onGone: (self: SandboxAcpConnection) => void,
  ) {}

  static async open(
    url: string,
    onGone: (self: SandboxAcpConnection) => void,
  ): Promise<SandboxAcpConnection> {
    const transport = connectAcpWebSocket(url);
    // `conn` is captured by the notification handlers below; it's assigned
    // before any frame can arrive (handlers only fire after `transport.ready`).
    let conn: SandboxAcpConnection;
    const connection = client({ name: "atelier-server" })
      .onNotification(methods.client.session.update, (ctx) => {
        conn.handlers.get(ctx.params.sessionId)?.onUpdate?.(ctx.params);
      })
      .onRequest(methods.client.session.requestPermission, async (ctx) => {
        const handler = conn.handlers.get(ctx.params.sessionId)?.onPermission;
        if (handler) return handler(ctx.params);
        log.warn(
          { sessionId: ctx.params.sessionId },
          "No permission handler registered; cancelling permission request",
        );
        return { outcome: { outcome: "cancelled" } };
      })
      .connect(transport.stream);
    conn = new SandboxAcpConnection(
      transport,
      connection,
      connection.agent,
      onGone,
    );

    try {
      await transport.ready;
      const init = await withTimeout(
        connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
        ACP_HANDSHAKE_TIMEOUT_MS,
        "initialize",
      );
      conn.canCloseSession =
        init.agentCapabilities?.sessionCapabilities?.close != null;
    } catch (err) {
      conn.close();
      throw err;
    }
    // A dropped socket (e.g. the acp process restarted) invalidates every
    // session on it; drop the connection so the next open() reconnects.
    void connection.closed.finally(() => conn.close());
    return conn;
  }

  registerSession(sessionId: string, callbacks: AgentSessionCallbacks): void {
    this.handlers.set(sessionId, callbacks);
  }

  /** Drop one session; close the shared socket when none remain. */
  releaseSession(sessionId: string): void {
    if (this.handlers.delete(sessionId) && this.handlers.size === 0) {
      this.close();
    }
  }

  get sessionCount(): number {
    return this.handlers.size;
  }

  /** Tear down the socket + ACP connection (idempotent). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    this.transport.close();
    this.connection.close();
    this.onGone(this);
  }
}

export class AgentDispatch {
  /**
   * One shared ACP connection per sandbox. Stored as the in-flight promise so
   * concurrent `openSession` calls dedupe onto a single rw attach (two rw
   * attaches would collide at the single-writer bridge).
   */
  private readonly connections = new Map<
    string,
    Promise<SandboxAcpConnection>
  >();
  /** ACP sessionId → the sandbox whose connection hosts it. */
  private readonly sessionSandbox = new Map<string, string>();

  constructor(private readonly deps: { agentClient: AgentClient }) {}

  private connectionFor(sandboxId: string): Promise<SandboxAcpConnection> {
    const existing = this.connections.get(sandboxId);
    if (existing) return existing;
    const pending = (async () => {
      const url = await this.deps.agentClient.attachUrl(
        sandboxId,
        ACP_PROCESS_NAME,
        "rw",
      );
      return SandboxAcpConnection.open(url, (self) => {
        // On teardown (socket drop / last release), drop this sandbox's
        // session index so it can't accumulate across reconnects, and forget
        // the connection only if this exact one is still mapped.
        for (const [sid, sbx] of this.sessionSandbox) {
          if (sbx === sandboxId) this.sessionSandbox.delete(sid);
        }
        const cur = this.connections.get(sandboxId);
        if (cur) {
          void cur.then(
            (c) => {
              if (c === self) this.connections.delete(sandboxId);
            },
            () => {},
          );
        }
      });
    })();
    this.connections.set(sandboxId, pending);
    // A failed open (attach/initialize) must not leave a rejected promise
    // cached, or the sandbox could never reconnect.
    pending.catch(() => {
      if (this.connections.get(sandboxId) === pending) {
        this.connections.delete(sandboxId);
      }
    });
    return pending;
  }

  async openSession(input: OpenAgentSessionInput): Promise<AgentSession> {
    const harness: HarnessDispatchAdapter = resolveHarnessDispatch(
      input.harnessId,
    );
    const conn = await this.connectionFor(input.sandboxId);
    const acp = conn.acp;

    const created = await withTimeout(
      acp.request(methods.agent.session.new, {
        cwd: input.cwd,
        mcpServers: input.mcpServers ?? [],
      }),
      ACP_HANDSHAKE_TIMEOUT_MS,
      "session/new",
    );
    conn.registerSession(created.sessionId, input.callbacks ?? {});
    this.sessionSandbox.set(created.sessionId, input.sandboxId);

    const session: AgentSession = {
      sessionId: created.sessionId,
      sandboxId: input.sandboxId,
      prompt: async (text, selection) => {
        const assignments = selection
          ? (harness.sessionConfig?.(selection) ?? [])
          : [];
        for (const { configId, value } of assignments) {
          await withTimeout(
            acp.request(methods.agent.session.setConfigOption, {
              sessionId: created.sessionId,
              configId,
              value,
            }),
            ACP_HANDSHAKE_TIMEOUT_MS,
            "session/set_config_option",
          );
        }
        return acp.request(methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "text", text }],
        });
      },
      cancel: () =>
        acp.notify(methods.agent.session.cancel, {
          sessionId: created.sessionId,
        }),
      close: async () => {
        if (!this.sessionSandbox.delete(created.sessionId)) return;
        // Free agent-side session state before releasing our attach. The acp
        // process is shared + persistent (unlike v1's per-session subprocess),
        // so without this its context/history would leak until it restarts.
        // Sent before releaseSession so the (possibly last) socket is still up.
        if (conn.canCloseSession) {
          await acp
            .request(methods.agent.session.close, {
              sessionId: created.sessionId,
            })
            .catch((err) =>
              log.warn(
                {
                  sandboxId: input.sandboxId,
                  sessionId: created.sessionId,
                  err,
                },
                "session/close failed",
              ),
            );
        }
        conn.releaseSession(created.sessionId);
      },
    };

    log.info(
      {
        sandboxId: input.sandboxId,
        sessionId: created.sessionId,
        harness: harness.id,
      },
      "ACP session opened",
    );
    return session;
  }

  async closeAll(sandboxId?: string): Promise<void> {
    const targets = sandboxId ? [sandboxId] : [...this.connections.keys()];
    for (const id of targets) {
      const pending = this.connections.get(id);
      if (!pending) continue;
      for (const [sessionId, sbx] of this.sessionSandbox) {
        if (sbx === id) this.sessionSandbox.delete(sessionId);
      }
      // close() is idempotent and refcount-independent, so a connection with
      // no registered sessions is torn down too.
      await pending.then(
        (conn) => conn.close(),
        () => {},
      );
    }
  }
}
