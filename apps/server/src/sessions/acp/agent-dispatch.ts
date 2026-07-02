/**
 * Agent-neutral ACP hub (atelier-v2 §3.1 "sessions/"). Speaks ACP JSON-RPC to
 * a sandbox's harness by **attaching to the already-supervised `acp` process**
 * through the runtime's unified attach bridge (agent-v2 attach.rs on :9997) —
 * not by spawning a per-session bridge subprocess. The `acp` process is
 * declared in the spec (`stdio: "bridge"`, `primary: true`, composed
 * client-side by `@atelier/compose`); the runtime boots it once and gates
 * health on it, so by the time a session opens it is already running.
 *
 * The attach bridge is single-writer, so ALL consumers of one sandbox share
 * ONE rw attach connection ({@link SandboxAcpConnection}). AgentDispatch is
 * the single owner of that connection and the single source of truth for a
 * sandbox's live ACP state: the session registry, the pending-permission
 * buffer, and a per-sandbox event emitter. The chat flow (`openSession`) and
 * the dashboard surface (`AcpSessionSurface`) are both just readers/drivers of
 * this hub — neither owns a socket.
 *
 * ACP has no "list sessions" RPC and no persistence guarantee, and this server
 * is the only prompter, so the registry is authoritative: a session it did not
 * create is one nothing can display. KNOWN GAP: after a server restart, live
 * acp-side sessions are invisible until recreated (acceptable — ephemeral).
 *
 * sessions/ is a privileged CLIENT of the runtime API here — attach + files,
 * the same surface any caller could use. It never touches k8s directly.
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
import type {
  AgentPermissionReply,
  AgentPermissionRequest,
  AgentSessionStatus,
  AgentTodo,
} from "@frak/atelier-shared";
import type { AgentClient } from "../../runtime/index.ts";
import { safeNanoid } from "../../shared/lib/id.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { InterventionResult } from "../session-surface.ts";
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

/** Registry entry for one ACP session — the authoritative server-side record
 * (ACP has no list RPC). `title`/`time` are synthesized. */
export interface SessionMeta {
  sessionId: string;
  title: string;
  directory: string;
  created: number;
  updated: number;
  /** >0 while a prompt is in flight (drives idle/busy status). */
  busyCount: number;
  todos: AgentTodo[];
}

/** A coarse cache-invalidation signal for the facade SSE stream (the
 * dashboard re-queries the affected resource; it never reads payloads). */
export interface SurfaceEvent {
  resource: "sessions" | "sessionStatuses" | "permissions" | "todos";
  sessionId?: string;
}
export type SurfaceListener = (event: SurfaceEvent) => void;

/** A buffered ACP permission request awaiting a decision (chat auto-approve or
 * dashboard reply — first `replyPermission` wins). */
interface PendingPermission {
  id: string;
  sessionId: string;
  request: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
}

export interface AgentSessionCallbacks {
  /** Chat streaming: raw ACP `session/update` notifications for this session. */
  onUpdate?: (notification: SessionNotification) => void;
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

function planEntryStatusToTodo(status: string): AgentTodo["status"] {
  switch (status) {
    case "in_progress":
      return "in_progress";
    case "completed":
      return "completed";
    default:
      return "pending";
  }
}

/** Pick the ACP option to answer a dashboard decision with. ACP requires an
 * offered `optionId`; `always` falls back to a once-allow when the agent
 * offers no persistent option. Returns undefined → answer "cancelled". */
function selectPermissionOption(
  request: RequestPermissionRequest,
  decision: AgentPermissionReply,
): string | undefined {
  const byKind = (kind: string) =>
    request.options.find((o) => o.kind === kind)?.optionId;
  if (decision === "reject") {
    return byKind("reject_once") ?? byKind("reject_always");
  }
  if (decision === "always") {
    return byKind("allow_always") ?? byKind("allow_once");
  }
  return byKind("allow_once") ?? byKind("allow_always");
}

type AgentProxy = ClientConnection["agent"];

/**
 * One shared ACP connection to a sandbox's `acp` process. Owns the single rw
 * attach WebSocket + ACP client connection and, for its lifetime, the
 * authoritative per-sandbox state: the session registry, pending-permission
 * buffer, and chat update handlers. It forwards coarse invalidation signals
 * out via `emit` (owned by AgentDispatch, so it survives connection churn).
 * The socket closes when the registry drains (last chat + dashboard session
 * released) — watching (SSE) is free and never keeps it alive.
 */
class SandboxAcpConnection {
  readonly sessions = new Map<string, SessionMeta>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly updateHandlers = new Map<
    string,
    (notification: SessionNotification) => void
  >();
  private closed = false;
  /** Whether the agent advertised `sessionCapabilities.close` at initialize. */
  canCloseSession = false;

  private constructor(
    private readonly transport: AcpTransport,
    private readonly connection: ClientConnection,
    readonly acp: AgentProxy,
    private readonly onGone: (self: SandboxAcpConnection) => void,
    private readonly emit: (event: SurfaceEvent) => void,
  ) {}

  static async open(
    url: string,
    onGone: (self: SandboxAcpConnection) => void,
    emit: (event: SurfaceEvent) => void,
  ): Promise<SandboxAcpConnection> {
    const transport = connectAcpWebSocket(url);
    // `conn` is captured by the handlers below; it's assigned before any frame
    // can arrive (handlers only fire after `transport.ready`).
    let conn: SandboxAcpConnection;
    const connection = client({ name: "atelier-server" })
      .onNotification(methods.client.session.update, (ctx) => {
        conn.handleUpdate(ctx.params);
      })
      .onRequest(methods.client.session.requestPermission, (ctx) =>
        conn.handlePermission(ctx.params),
      )
      .connect(transport.stream);
    conn = new SandboxAcpConnection(
      transport,
      connection,
      connection.agent,
      onGone,
      emit,
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

  // ── ACP inbound ──────────────────────────────────────────────────────────

  private handleUpdate(notification: SessionNotification): void {
    // Chat streaming first (raw passthrough), regardless of registry state.
    this.updateHandlers.get(notification.sessionId)?.(notification);

    const meta = this.sessions.get(notification.sessionId);
    if (!meta) {
      // Stale/unknown session (e.g. post-restart) — ignore, never crash/emit.
      log.debug(
        { sessionId: notification.sessionId },
        "session/update for unknown session; ignoring",
      );
      return;
    }
    meta.updated = Date.now();
    if (notification.update.sessionUpdate === "plan") {
      meta.todos = notification.update.entries.map((e) => ({
        content: e.content,
        status: planEntryStatusToTodo(e.status),
        priority: e.priority,
      }));
      this.emit({ resource: "todos", sessionId: notification.sessionId });
    }
  }

  private handlePermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const id = safeNanoid();
    return new Promise<RequestPermissionResponse>((resolve) => {
      this.pendingPermissions.set(id, {
        id,
        sessionId: request.sessionId,
        request,
        resolve,
      });
      this.emit({ resource: "permissions" });
    });
  }

  // ── registry / sessions ───────────────────────────────────────────────────

  async newSession(
    cwd: string,
    mcpServers: McpServer[],
    title: string,
  ): Promise<string> {
    const created = await withTimeout(
      this.acp.request(methods.agent.session.new, { cwd, mcpServers }),
      ACP_HANDSHAKE_TIMEOUT_MS,
      "session/new",
    );
    const now = Date.now();
    this.sessions.set(created.sessionId, {
      sessionId: created.sessionId,
      title,
      directory: cwd,
      created: now,
      updated: now,
      busyCount: 0,
      todos: [],
    });
    this.emit({ resource: "sessions" });
    return created.sessionId;
  }

  setTitle(sessionId: string, title: string): void {
    const meta = this.sessions.get(sessionId);
    if (!meta || meta.title === title) return;
    meta.title = title;
    meta.updated = Date.now();
    this.emit({ resource: "sessions" });
  }

  registerUpdateHandler(
    sessionId: string,
    handler: (notification: SessionNotification) => void,
  ): void {
    this.updateHandlers.set(sessionId, handler);
  }

  markBusy(sessionId: string, delta: number): void {
    const meta = this.sessions.get(sessionId);
    if (!meta) return;
    meta.busyCount = Math.max(0, meta.busyCount + delta);
    meta.updated = Date.now();
    this.emit({ resource: "sessionStatuses" });
  }

  cancel(sessionId: string): Promise<void> {
    return this.acp.notify(methods.agent.session.cancel, { sessionId });
  }

  /** Free agent-side session state (capability-gated) + drop it from the
   * registry; closes the socket if the registry drains. Idempotent. */
  async closeSession(sessionId: string): Promise<boolean> {
    if (!this.sessions.delete(sessionId)) return false;
    this.updateHandlers.delete(sessionId);
    if (this.canCloseSession) {
      await this.acp
        .request(methods.agent.session.close, { sessionId })
        .catch((err) => log.warn({ sessionId, err }, "session/close failed"));
    }
    this.emit({ resource: "sessions" });
    if (this.sessions.size === 0) this.close();
    return true;
  }

  // ── surface reads ─────────────────────────────────────────────────────────

  listSessions(): SessionMeta[] {
    return [...this.sessions.values()];
  }

  getSession(sessionId: string): SessionMeta | undefined {
    return this.sessions.get(sessionId);
  }

  statuses(): Record<string, AgentSessionStatus> {
    const out: Record<string, AgentSessionStatus> = {};
    for (const meta of this.sessions.values()) {
      out[meta.sessionId] = { type: meta.busyCount > 0 ? "busy" : "idle" };
    }
    return out;
  }

  listPermissions(): AgentPermissionRequest[] {
    return [...this.pendingPermissions.values()].map((p) => ({
      id: p.id,
      sessionId: p.sessionId,
      permission:
        p.request.toolCall.title ?? p.request.toolCall.kind ?? "permission",
    }));
  }

  replyPermission(
    requestId: string,
    decision: AgentPermissionReply,
  ): InterventionResult {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return { ok: false, status: 404 };
    this.pendingPermissions.delete(requestId);
    const optionId = selectPermissionOption(pending.request, decision);
    pending.resolve(
      optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } },
    );
    this.emit({ resource: "permissions" });
    return { ok: true };
  }

  /** Tear down the socket + ACP connection (idempotent). Flushes pending
   * permissions as cancelled and clears the registry so no ghost state
   * lingers; emits the invalidations so watchers reflect the wipe. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const hadPermissions = this.pendingPermissions.size > 0;
    const hadSessions = this.sessions.size > 0;
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
    this.sessions.clear();
    this.updateHandlers.clear();
    if (hadPermissions) this.emit({ resource: "permissions" });
    if (hadSessions) this.emit({ resource: "sessions" });
    this.transport.close();
    this.connection.close();
    this.onGone(this);
  }
}

export class AgentDispatch {
  /**
   * One shared ACP connection per sandbox, stored as the in-flight promise so
   * concurrent dials dedupe onto a single rw attach (two rw attaches would
   * collide at the single-writer bridge).
   */
  private readonly connections = new Map<
    string,
    Promise<SandboxAcpConnection>
  >();
  /** Resolved connections, for synchronous lazy-read (no dial). */
  private readonly live = new Map<string, SandboxAcpConnection>();
  /** Per-sandbox event subscribers. Kept on the hub (NOT the connection) so an
   * SSE watcher survives connection churn and is never a refcount participant
   * that could strand or wipe the socket. */
  private readonly subscribers = new Map<string, Set<SurfaceListener>>();

  constructor(private readonly deps: { agentClient: AgentClient }) {}

  // ── event emitter ─────────────────────────────────────────────────────────

  /** Watch a sandbox's coarse invalidation signals. Does NOT dial. */
  subscribe(sandboxId: string, listener: SurfaceListener): () => void {
    let set = this.subscribers.get(sandboxId);
    if (!set) {
      set = new Set();
      this.subscribers.set(sandboxId, set);
    }
    set.add(listener);
    return () => {
      const s = this.subscribers.get(sandboxId);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.subscribers.delete(sandboxId);
    };
  }

  private emit(sandboxId: string, event: SurfaceEvent): void {
    const set = this.subscribers.get(sandboxId);
    if (!set) return;
    for (const listener of set) {
      try {
        listener(event);
      } catch (err) {
        log.warn({ sandboxId, err }, "surface listener threw");
      }
    }
  }

  // ── connection lifecycle ──────────────────────────────────────────────────

  private connectionFor(sandboxId: string): Promise<SandboxAcpConnection> {
    const existing = this.connections.get(sandboxId);
    if (existing) return existing;
    const pending = (async () => {
      const url = await this.deps.agentClient.attachUrl(
        sandboxId,
        ACP_PROCESS_NAME,
        "rw",
      );
      const conn = await SandboxAcpConnection.open(
        url,
        (self) => {
          if (this.live.get(sandboxId) === self) this.live.delete(sandboxId);
          const cur = this.connections.get(sandboxId);
          if (cur) {
            void cur.then(
              (c) => {
                if (c === self) this.connections.delete(sandboxId);
              },
              () => {},
            );
          }
        },
        (event) => this.emit(sandboxId, event),
      );
      this.live.set(sandboxId, conn);
      return conn;
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

  // ── surface reads (lazy: no live connection → empty, never dial) ───────────

  sessionsFor(sandboxId: string): SessionMeta[] {
    return this.live.get(sandboxId)?.listSessions() ?? [];
  }

  sessionFor(sandboxId: string, sessionId: string): SessionMeta | undefined {
    return this.live.get(sandboxId)?.getSession(sessionId);
  }

  statusesFor(sandboxId: string): Record<string, AgentSessionStatus> {
    return this.live.get(sandboxId)?.statuses() ?? {};
  }

  todosFor(sandboxId: string, sessionId: string): AgentTodo[] {
    return this.live.get(sandboxId)?.getSession(sessionId)?.todos ?? [];
  }

  permissionsFor(sandboxId: string): AgentPermissionRequest[] {
    return this.live.get(sandboxId)?.listPermissions() ?? [];
  }

  replyPermission(
    sandboxId: string,
    requestId: string,
    decision: AgentPermissionReply,
  ): InterventionResult {
    const conn = this.live.get(sandboxId);
    if (!conn) return { ok: false, status: 404 };
    return conn.replyPermission(requestId, decision);
  }

  // ── surface drivers (dial when needed) ─────────────────────────────────────

  /** Dashboard-initiated session. Dials the sandbox. */
  async createSession(
    sandboxId: string,
    directory: string,
  ): Promise<{ sessionId: string; directory: string }> {
    const conn = await this.connectionFor(sandboxId);
    const sessionId = await conn.newSession(directory, [], titleFor(directory));
    return { sessionId, directory };
  }

  async closeSession(sandboxId: string, sessionId: string): Promise<boolean> {
    const conn = this.live.get(sandboxId);
    if (!conn) return false;
    return conn.closeSession(sessionId);
  }

  async abortSession(sandboxId: string, sessionId: string): Promise<boolean> {
    const conn = this.live.get(sandboxId);
    if (!conn) return false;
    if (!conn.getSession(sessionId)) return false;
    await conn.cancel(sessionId);
    return true;
  }

  // ── chat flow ──────────────────────────────────────────────────────────────

  async openSession(input: OpenAgentSessionInput): Promise<AgentSession> {
    const harness: HarnessDispatchAdapter = resolveHarnessDispatch(
      input.harnessId,
    );
    const conn = await this.connectionFor(input.sandboxId);
    const acp = conn.acp;
    const sessionId = await conn.newSession(
      input.cwd,
      input.mcpServers ?? [],
      titleFor(input.cwd),
    );
    if (input.callbacks?.onUpdate) {
      conn.registerUpdateHandler(sessionId, input.callbacks.onUpdate);
    }
    let titledByPrompt = false;

    const session: AgentSession = {
      sessionId,
      sandboxId: input.sandboxId,
      prompt: async (text, selection) => {
        if (!titledByPrompt) {
          titledByPrompt = true;
          conn.setTitle(sessionId, truncateTitle(text));
        }
        const assignments = selection
          ? (harness.sessionConfig?.(selection) ?? [])
          : [];
        for (const { configId, value } of assignments) {
          await withTimeout(
            acp.request(methods.agent.session.setConfigOption, {
              sessionId,
              configId,
              value,
            }),
            ACP_HANDSHAKE_TIMEOUT_MS,
            "session/set_config_option",
          );
        }
        conn.markBusy(sessionId, 1);
        try {
          return await acp.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text }],
          });
        } finally {
          conn.markBusy(sessionId, -1);
        }
      },
      cancel: () => conn.cancel(sessionId),
      close: async () => {
        await conn.closeSession(sessionId);
      },
    };

    log.info(
      { sandboxId: input.sandboxId, sessionId, harness: harness.id },
      "ACP session opened",
    );
    return session;
  }

  async closeAll(sandboxId?: string): Promise<void> {
    const targets = sandboxId ? [sandboxId] : [...this.connections.keys()];
    for (const id of targets) {
      const pending = this.connections.get(id);
      if (!pending) continue;
      await pending.then(
        (conn) => conn.close(),
        () => {},
      );
    }
  }
}

/** Synthesized title for a freshly created session (before any prompt). */
function titleFor(directory: string): string {
  const base = directory.replace(/\/+$/, "").split("/").pop();
  return base && base.length > 0 ? base : `Session ${safeNanoid().slice(0, 6)}`;
}

function truncateTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
}
