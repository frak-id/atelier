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
 * sandbox's live ACP state: pending-permission buffer, per-sandbox event
 * emitter, and (for agents lacking `session/list`) a minimal fallback of
 * server-created session ids. The chat flow (`openSession`) and the
 * dashboard surface (`AcpSessionSurface`) are both just readers/drivers of
 * this hub — neither owns a socket.
 *
 * Session identity/title/cwd come from the agent's own `session/list` (ACP
 * 1.1+, capability-gated) rather than a server-local registry, so sessions
 * started outside this server (e.g. from a terminal) are visible too. Busy
 * state and todos have no ACP list equivalent, so they stay as ephemeral
 * per-connection overlays keyed by session id.
 *
 * sessions/ is a privileged CLIENT of the runtime API here — attach + files,
 * the same surface any caller could use. It never touches k8s directly.
 */
import {
  type ClientConnection,
  client,
  type ListSessionsResponse,
  type McpServer,
  methods,
  PROTOCOL_VERSION,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionInfo,
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

/** Hard cap on `session/list` pagination (10 pages × ~50/page ballpark) so a
 * misbehaving agent can't make a list call loop forever. */
const MAX_LIST_PAGES = 10;

/** Aggregate wall-clock budget for a whole `session/list` (all pages). Bounds
 * a slow-but-not-timing-out agent to a dashboard-reasonable latency instead of
 * `MAX_LIST_PAGES × ACP_HANDSHAKE_TIMEOUT_MS` (which would hold the socket for
 * minutes and block the idle-close). */
const ACP_LIST_TOTAL_BUDGET_MS = 20_000;

/** How long a connection may sit with no holds, no busy sessions, and no
 * pending permissions before it's closed. Keeps dashboard polling from
 * re-dialing on every request while still releasing the socket eventually.
 * Overridable via env for tests; production always gets the 60s default. */
const ACP_IDLE_TTL_MS = Number(process.env.ACP_IDLE_TTL_MS) || 60_000;

/**
 * The supervised process that carries the ACP bridge. Convention from the
 * harness composers (`@atelier/compose`): the harness emits a `stdio: "bridge"`
 * primary process named `acp`. sessions/ attaches to it by name.
 */
const ACP_PROCESS_NAME = "acp";

/** A session as surfaced to the dashboard. Sourced from `session/list` (or,
 * for agents lacking that capability, the server-created fallback); never
 * cached authoritatively. */
export interface SessionMeta {
  sessionId: string;
  title: string;
  directory: string;
  created: number;
  updated: number;
}

/** Ephemeral, per-connection live state that `session/list` cannot supply.
 * Absent entry == not server-driven right now (not busy, no todos). Created
 * lazily on the first `plan`/`session_info_update` or prompt for a session —
 * including ones this server never created. */
interface LiveSessionState {
  busyCount: number;
  todos: AgentTodo[];
  titleOverride?: string;
}

/** Minimal creation record for the capability-gated fallback used when the
 * agent doesn't support `session/list` (kept on {@link AgentDispatch}, not the
 * connection, so it survives idle-TTL reconnects). */
interface CreatedSessionEntry {
  sessionId: string;
  cwd: string;
  title: string;
  created: number;
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
 * pending-permission buffer, chat update handlers, and the ephemeral live
 * overlay (busy/todos/title). Forwards coarse invalidation signals out via
 * `emit` (owned by AgentDispatch, so it survives connection churn).
 *
 * The socket is governed by a hold-count + idle TTL (see `acquire`/`release`),
 * not by registry occupancy: a hold, a pending permission, or a busy session
 * all keep it open; once none of those apply it closes after
 * {@link ACP_IDLE_TTL_MS} of inactivity. SSE subscribers never hold it open —
 * watching is free.
 */
class SandboxAcpConnection {
  private readonly liveState = new Map<string, LiveSessionState>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly updateHandlers = new Map<
    string,
    (notification: SessionNotification) => void
  >();
  private closed = false;
  /** Whether the agent advertised `sessionCapabilities.close` at initialize. */
  canCloseSession = false;
  /** Whether the agent advertised `sessionCapabilities.list` at initialize. */
  canListSessions = false;
  private holdCount = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    private readonly transport: AcpTransport,
    private readonly connection: ClientConnection,
    readonly acp: AgentProxy,
    private readonly onGone: (self: SandboxAcpConnection) => void,
    private readonly emit: (event: SurfaceEvent) => void,
    /** Shared with {@link AgentDispatch}; outlives this connection instance
     * (idle-TTL reconnects must not lose track of server-created sessions on
     * agents without `session/list`). */
    private readonly createdSessions: Map<string, CreatedSessionEntry>,
  ) {}

  static async open(
    url: string,
    onGone: (self: SandboxAcpConnection) => void,
    emit: (event: SurfaceEvent) => void,
    createdSessions: Map<string, CreatedSessionEntry>,
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
      createdSessions,
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
      conn.canListSessions =
        init.agentCapabilities?.sessionCapabilities?.list != null;
    } catch (err) {
      conn.close();
      throw err;
    }
    // A dropped socket (e.g. the acp process restarted) invalidates every
    // session on it; drop the connection so the next open() reconnects.
    void connection.closed.finally(() => conn.close());
    return conn;
  }

  // ── hold / idle-TTL lifecycle ─────────────────────────────────────────────

  /** Mark the connection in-use (an in-flight list/dial/prompt). Cancels any
   * pending idle-close. Always pair with `release()`. */
  acquire(): void {
    this.holdCount++;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Release a hold acquired via `acquire()`. Arms the idle-close timer once
   * nothing else (holds, busy sessions, pending permissions) needs the
   * socket. */
  release(): void {
    this.holdCount = Math.max(0, this.holdCount - 1);
    this.maybeScheduleIdleClose();
  }

  private isIdleBlocked(): boolean {
    if (this.holdCount > 0 || this.pendingPermissions.size > 0) return true;
    for (const state of this.liveState.values()) {
      if (state.busyCount > 0) return true;
    }
    return false;
  }

  private maybeScheduleIdleClose(): void {
    if (this.closed || this.idleTimer || this.isIdleBlocked()) return;
    // Recheck at fire time, not just at arm time: a permission/prompt may
    // start after the timer is armed and must still keep the socket open.
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (!this.isIdleBlocked()) this.close();
    }, ACP_IDLE_TTL_MS);
  }

  // ── ACP inbound ──────────────────────────────────────────────────────────

  private getOrCreateLiveState(sessionId: string): LiveSessionState {
    let state = this.liveState.get(sessionId);
    if (!state) {
      state = { busyCount: 0, todos: [] };
      this.liveState.set(sessionId, state);
    }
    return state;
  }

  private handleUpdate(notification: SessionNotification): void {
    // Chat streaming first (raw passthrough), regardless of live state.
    this.updateHandlers.get(notification.sessionId)?.(notification);

    const update = notification.update;
    if (update.sessionUpdate === "plan") {
      const state = this.getOrCreateLiveState(notification.sessionId);
      state.todos = update.entries.map((e) => ({
        content: e.content,
        status: planEntryStatusToTodo(e.status),
        priority: e.priority,
      }));
      this.emit({ resource: "todos", sessionId: notification.sessionId });
      return;
    }
    if (update.sessionUpdate === "session_info_update") {
      // `undefined` = field absent (no change); `null` = explicit clear, which
      // drops our override so listSessions falls back to SessionInfo.title.
      if (update.title !== undefined) {
        const state = this.getOrCreateLiveState(notification.sessionId);
        state.titleOverride = update.title ?? undefined;
        this.emit({ resource: "sessions" });
      }
      return;
    }
    // Other update kinds (message chunks, tool calls, ...) carry nothing this
    // hub tracks — the chat passthrough above already forwarded them.
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

  // ── sessions ───────────────────────────────────────────────────────────────

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
    // The fallback registry is only ever READ when the agent lacks
    // `session/list`; populating it for list-capable agents (the common case)
    // would leak an entry per session that nothing prunes. Skip it there.
    if (!this.canListSessions) {
      this.createdSessions.set(created.sessionId, {
        sessionId: created.sessionId,
        cwd,
        title,
        created: Date.now(),
      });
    }
    this.emit({ resource: "sessions" });
    return created.sessionId;
  }

  registerUpdateHandler(
    sessionId: string,
    handler: (notification: SessionNotification) => void,
  ): void {
    this.updateHandlers.set(sessionId, handler);
  }

  markBusy(sessionId: string, delta: number): void {
    const state = this.getOrCreateLiveState(sessionId);
    state.busyCount = Math.max(0, state.busyCount + delta);
    this.emit({ resource: "sessionStatuses" });
    this.maybeScheduleIdleClose();
  }

  cancel(sessionId: string): Promise<void> {
    return this.acp.notify(methods.agent.session.cancel, { sessionId });
  }

  /** Free agent-side session state (capability-gated) + drop it from the
   * fallback registry. Idempotent-ish: returns whether it was known here or
   * the agent-side close succeeded. */
  async closeSession(sessionId: string): Promise<boolean> {
    const hadFallback = this.createdSessions.delete(sessionId);
    this.liveState.delete(sessionId);
    this.updateHandlers.delete(sessionId);
    let closed = hadFallback;
    if (this.canCloseSession) {
      try {
        await this.acp.request(methods.agent.session.close, { sessionId });
        closed = true;
      } catch (err) {
        log.warn({ sessionId, err }, "session/close failed");
      }
    }
    this.emit({ resource: "sessions" });
    this.maybeScheduleIdleClose();
    return closed;
  }

  // ── surface reads (dial: session/list, or the fallback) ────────────────────

  private toSessionMeta(info: SessionInfo): SessionMeta {
    const live = this.liveState.get(info.sessionId);
    // ACP `SessionInfo` has no creation timestamp — `created` mirrors
    // `updatedAt` (best available); list-sourced sessions can't sort by age.
    const updated = info.updatedAt ? Date.parse(info.updatedAt) : 0;
    return {
      sessionId: info.sessionId,
      title: live?.titleOverride ?? info.title ?? titleFor(info.cwd),
      directory: info.cwd,
      created: updated,
      updated,
    };
  }

  private toFallbackMeta(entry: CreatedSessionEntry): SessionMeta {
    const live = this.liveState.get(entry.sessionId);
    return {
      sessionId: entry.sessionId,
      title: live?.titleOverride ?? entry.title,
      directory: entry.cwd,
      created: entry.created,
      updated: entry.created,
    };
  }

  async listSessions(): Promise<SessionMeta[]> {
    if (!this.canListSessions) {
      return [...this.createdSessions.values()].map((entry) =>
        this.toFallbackMeta(entry),
      );
    }
    const infos: SessionInfo[] = [];
    let cursor: string | undefined;
    const deadline = Date.now() + ACP_LIST_TOTAL_BUDGET_MS;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        log.warn(
          { pages: page },
          "session/list total budget exhausted; returning partial list",
        );
        break;
      }
      const res = await this.requestSessionListPage(cursor, deadline);
      // A spec-compliant agent always returns an array; guard anyway so a
      // malformed response degrades to empty instead of throwing on spread.
      infos.push(...(res.sessions ?? []));
      cursor = res.nextCursor ?? undefined;
      if (!cursor) break;
      if (page === MAX_LIST_PAGES - 1) {
        log.warn(
          { pages: MAX_LIST_PAGES },
          "session/list pagination cap reached; some sessions may be missing",
        );
      }
    }
    return infos.map((info) => this.toSessionMeta(info));
  }

  /** One `session/list` page. pi-acp intermittently returns a `null` sessions
   * array on the FIRST call after a fresh connect (its session store isn't
   * warm yet); the immediate retry on the same connection returns the real
   * page. Retry once on a null `sessions` to spare the caller an empty first
   * poll. Bounded by the shared list budget. */
  private async requestSessionListPage(
    cursor: string | undefined,
    deadline: number,
  ): Promise<ListSessionsResponse> {
    const call = () =>
      withTimeout(
        this.acp.request(methods.agent.session.list, { cursor }),
        Math.min(Math.max(deadline - Date.now(), 1), ACP_HANDSHAKE_TIMEOUT_MS),
        "session/list",
      );
    const res = await call();
    return res.sessions == null ? call() : res;
  }

  /** `session/list` + find. Never `session/load` — that replays history and
   * has side effects; reads must stay side-effect free. */
  async getSession(sessionId: string): Promise<SessionMeta | undefined> {
    const sessions = await this.listSessions();
    return sessions.find((s) => s.sessionId === sessionId);
  }

  async statuses(): Promise<Record<string, AgentSessionStatus>> {
    const sessions = await this.listSessions();
    const out: Record<string, AgentSessionStatus> = {};
    for (const s of sessions) {
      const busy = (this.liveState.get(s.sessionId)?.busyCount ?? 0) > 0;
      out[s.sessionId] = { type: busy ? "busy" : "idle" };
    }
    return out;
  }

  todosFor(sessionId: string): AgentTodo[] {
    return this.liveState.get(sessionId)?.todos ?? [];
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
    this.maybeScheduleIdleClose();
    return { ok: true };
  }

  /** Tear down the socket + ACP connection (idempotent). Flushes pending
   * permissions as cancelled; emits the invalidation so watchers reflect it.
   * Does NOT touch `createdSessions` — that fallback registry is owned by
   * `AgentDispatch` and must survive an idle-TTL reconnect. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    const hadPermissions = this.pendingPermissions.size > 0;
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
    this.liveState.clear();
    this.updateHandlers.clear();
    if (hadPermissions) this.emit({ resource: "permissions" });
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
  /** Capability-gated fallback for agents without `session/list`: ids this
   * server created. Kept per-sandbox on the hub (not the connection) so an
   * idle-TTL reconnect doesn't lose track of them. */
  private readonly createdSessions = new Map<
    string,
    Map<string, CreatedSessionEntry>
  >();

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

  private createdSessionsFor(
    sandboxId: string,
  ): Map<string, CreatedSessionEntry> {
    let map = this.createdSessions.get(sandboxId);
    if (!map) {
      map = new Map();
      this.createdSessions.set(sandboxId, map);
    }
    return map;
  }

  private connectionFor(sandboxId: string): Promise<SandboxAcpConnection> {
    const existing = this.connections.get(sandboxId);
    if (existing) return existing;
    const createdSessions = this.createdSessionsFor(sandboxId);
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
          // Drop an empty fallback map so read-only dials don't leak one entry
          // per sandbox ever touched (list-capable agents never populate it).
          if (createdSessions.size === 0) {
            this.createdSessions.delete(sandboxId);
          }
        },
        (event) => this.emit(sandboxId, event),
        createdSessions,
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

  /** Dial (or reuse) the sandbox's connection, holding it for the duration of
   * `fn` so it can't idle-close mid-operation. */
  private async withHold<T>(
    sandboxId: string,
    fn: (conn: SandboxAcpConnection) => Promise<T>,
  ): Promise<T> {
    const conn = await this.connectionFor(sandboxId);
    conn.acquire();
    try {
      return await fn(conn);
    } finally {
      conn.release();
    }
  }

  // ── surface reads (dial as needed; held for the call's duration) ───────────

  sessionsFor(sandboxId: string): Promise<SessionMeta[]> {
    return this.withHold(sandboxId, (conn) => conn.listSessions());
  }

  sessionFor(
    sandboxId: string,
    sessionId: string,
  ): Promise<SessionMeta | undefined> {
    return this.withHold(sandboxId, (conn) => conn.getSession(sessionId));
  }

  statusesFor(sandboxId: string): Promise<Record<string, AgentSessionStatus>> {
    return this.withHold(sandboxId, (conn) => conn.statuses());
  }

  /** Todos live only in the connection's in-memory overlay (populated by
   * `plan` notifications during a server-driven prompt). Lazy read, never
   * dial: no live connection → no server-driven prompt → empty. */
  todosFor(sandboxId: string, sessionId: string): Promise<AgentTodo[]> {
    return Promise.resolve(this.live.get(sandboxId)?.todosFor(sessionId) ?? []);
  }

  // ── surface reads (lazy: no live connection → empty, never dial) ───────────

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
    return this.withHold(sandboxId, async (conn) => {
      const sessionId = await conn.newSession(
        directory,
        [],
        titleFor(directory),
      );
      return { sessionId, directory };
    });
  }

  async closeSession(sandboxId: string, sessionId: string): Promise<boolean> {
    const conn = this.live.get(sandboxId);
    if (!conn) return false;
    // Hold across the close RPC so the idle timer can't fire mid-call (which
    // would tear the socket and turn a valid close into a spurious failure).
    conn.acquire();
    try {
      return await conn.closeSession(sessionId);
    } finally {
      conn.release();
    }
  }

  async abortSession(sandboxId: string, sessionId: string): Promise<boolean> {
    const conn = this.live.get(sandboxId);
    if (!conn) return false;
    conn.acquire();
    try {
      await conn.cancel(sessionId);
      return true;
    } finally {
      conn.release();
    }
  }

  // ── chat flow ──────────────────────────────────────────────────────────────

  async openSession(input: OpenAgentSessionInput): Promise<AgentSession> {
    const harness: HarnessDispatchAdapter = resolveHarnessDispatch(
      input.harnessId,
    );
    const conn = await this.connectionFor(input.sandboxId);
    const acp = conn.acp;
    // Hold for the SESSION'S LIFETIME (released in `close()`), not just for
    // newSession: an open chat session is active use, so the socket must not
    // idle-close under it (faithful to the pre-`session/list` behavior where a
    // non-empty registry kept the socket open). A caller that never calls
    // close() keeps one hold, same failure mode as any explicit-close resource.
    conn.acquire();
    let sessionId: string;
    try {
      sessionId = await conn.newSession(
        input.cwd,
        input.mcpServers ?? [],
        titleFor(input.cwd),
      );
    } catch (err) {
      conn.release();
      throw err;
    }
    if (input.callbacks?.onUpdate) {
      conn.registerUpdateHandler(sessionId, input.callbacks.onUpdate);
    }

    const session: AgentSession = {
      sessionId,
      sandboxId: input.sandboxId,
      prompt: async (text, selection) => {
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
        try {
          await conn.closeSession(sessionId);
        } finally {
          conn.release();
        }
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

/** Synthesized title for a freshly created session (before any prompt) or the
 * basename fallback when the agent's `session/list`/creation title is null. */
function titleFor(directory: string): string {
  const base = directory.replace(/\/+$/, "").split("/").pop();
  return base && base.length > 0 ? base : `Session ${safeNanoid().slice(0, 6)}`;
}
