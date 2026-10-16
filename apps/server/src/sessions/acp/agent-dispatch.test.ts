/**
 * AgentDispatch against a fake ACP agent (no real sandbox/attach bridge): a
 * Bun WebSocket server wired to an `agent()` app from the SDK. Exercises the
 * `session/list`-backed surface, the busy/todos/title overlays, the
 * capability-gated fallback for agents without `session/list`, and the
 * hold/idle-TTL connection lifecycle.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
// Type-only (erased at runtime), so it does not load the module before the env
// below is set.
import type {
  PermissionNotifier,
  PermissionPrompt,
} from "../permission-notifier.ts";

process.env.ACP_IDLE_TTL_MS = "40";

let AgentDispatch: typeof import("./agent-dispatch.ts").AgentDispatch;
let agent: typeof import("@agentclientprotocol/sdk").agent;
let methods: typeof import("@agentclientprotocol/sdk").methods;
let ndJsonStream: typeof import("@agentclientprotocol/sdk").ndJsonStream;
let PROTOCOL_VERSION: typeof import("@agentclientprotocol/sdk").PROTOCOL_VERSION;
let RequestError: typeof import("@agentclientprotocol/sdk").RequestError;
type AgentContext = import("@agentclientprotocol/sdk").AgentContext;
type AgentClientType = import("../../runtime/index.ts").AgentClient;

beforeAll(async () => {
  // ACP_IDLE_TTL_MS is read once at module load, so set it before importing.
  ({ AgentDispatch } = await import("./agent-dispatch.ts"));
  ({ agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } =
    await import("@agentclientprotocol/sdk"));
  const { registerHarnessDispatch } = await import("./harness-registry.ts");
  registerHarnessDispatch({ id: "opencode" });
});

interface FakeSession {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

class FakeAcpAgent {
  readonly sessions = new Map<string, FakeSession>();
  canList = true;
  canClose = true;
  nullFirstList = false;
  /** When set, `session/new` fails with this message. */
  failNewSession: string | undefined;
  canLoad = true;
  readonly loaded: string[] = [];
  listCallCount = 0;
  promptDelayMs = 5;
  clientCtx?: AgentContext;
  private nextId = 1;

  get app() {
    return agent()
      .onRequest(methods.agent.initialize, (ctx) => {
        this.clientCtx = ctx.client;
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: this.canLoad,
            sessionCapabilities: {
              list: this.canList ? {} : undefined,
              close: this.canClose ? {} : undefined,
            },
          },
        };
      })
      .onRequest(methods.agent.session.new, (ctx) => {
        if (this.failNewSession) {
          throw new RequestError(-32603, this.failNewSession);
        }
        const sessionId = `sess-${this.nextId++}`;
        this.sessions.set(sessionId, { sessionId, cwd: ctx.params.cwd });
        return { sessionId };
      })
      .onRequest(methods.agent.session.load, async (ctx) => {
        if (!this.sessions.has(ctx.params.sessionId)) {
          throw new RequestError(-32602, "Unknown sessionId");
        }
        // Like pi-acp: the history replays as updates before the answer.
        await ctx.client.notify(methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "(history)" },
          },
        });
        this.loaded.push(ctx.params.sessionId);
        return {};
      })
      .onRequest(methods.agent.session.list, () => {
        // Emulate pi-acp's cold-start quirk: first call after connect returns a
        // null `sessions`, the retry returns the real page.
        if (this.nullFirstList && this.listCallCount++ === 0) {
          return { sessions: null } as unknown as { sessions: FakeSession[] };
        }
        return { sessions: [...this.sessions.values()] };
      })
      .onRequest(methods.agent.session.close, (ctx) => {
        this.sessions.delete(ctx.params.sessionId);
        return {};
      })
      .onRequest(methods.agent.session.setConfigOption, () => ({
        configOptions: [],
      }))
      .onRequest(methods.agent.session.prompt, async () => {
        await new Promise((resolve) => setTimeout(resolve, this.promptDelayMs));
        return { stopReason: "end_turn" as const };
      })
      .onNotification(methods.agent.session.cancel, () => {});
  }

  seedSession(sessionId: string, cwd: string, title?: string): void {
    this.sessions.set(sessionId, { sessionId, cwd, title });
  }

  async emitPlan(
    sessionId: string,
    entries: { content: string; priority: "medium"; status: string }[],
  ): Promise<void> {
    await this.clientCtx?.notify(methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "plan", entries },
    });
  }

  async emitTitle(sessionId: string, title: string | null): Promise<void> {
    await this.clientCtx?.notify(methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "session_info_update", title },
    });
  }

  /** Fires a `session/request_permission` the client must reply to. Resolves
   * once answered — call without awaiting to leave it pending. */
  requestPermission(sessionId: string): Promise<unknown> {
    if (!this.clientCtx) throw new Error("no client connected yet");
    return this.clientCtx.request(methods.client.session.requestPermission, {
      sessionId,
      toolCall: { toolCallId: "tc-1", title: "Run a thing", kind: "execute" },
      options: [
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
  }
}

interface FakeServer {
  url: string;
  closed: () => boolean;
  stop: () => void;
}

/**
 * `replay` emulates the in-pod attach bridge: every new connection first
 * receives `replay.seed` (raw NDJSON a previous server left in the bridge's
 * buffer) and then everything the agent wrote to earlier connections.
 */
function startFakeAgentServer(
  fakeAgent: FakeAcpAgent,
  replay?: { seed: string },
): FakeServer {
  const controllers = new WeakMap<
    ServerWebSocket<unknown>,
    ReadableStreamDefaultController<Uint8Array>
  >();
  const buffered: Uint8Array[] = replay
    ? [new TextEncoder().encode(replay.seed)]
    : [];
  let sawClose = false;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        if (replay) for (const chunk of buffered) ws.send(chunk);
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const readable = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        });
        const writable = new WritableStream<Uint8Array>({
          write(chunk) {
            if (replay) buffered.push(chunk);
            ws.send(chunk);
          },
        });
        controllers.set(ws, controller);
        void fakeAgent.app
          .connect(ndJsonStream(writable, readable))
          .closed.then(
            () => {
              sawClose = true;
            },
            () => {
              sawClose = true;
            },
          );
      },
      message(ws, message) {
        const controller = controllers.get(ws);
        if (!controller) return;
        const bytes =
          typeof message === "string"
            ? new TextEncoder().encode(message)
            : new Uint8Array(message);
        controller.enqueue(bytes);
      },
      close(ws) {
        controllers.get(ws)?.close();
      },
    },
  });
  return {
    url: `ws://localhost:${server.port}`,
    closed: () => sawClose,
    stop: () => server.stop(true),
  };
}

function makeDispatch(
  fakeAgent: FakeAcpAgent,
  notifier?: PermissionNotifier,
  onActivity?: (sandboxId: string) => void,
  replay?: { seed: string },
): {
  dispatch: InstanceType<typeof AgentDispatch>;
  stop: () => void;
} {
  const server = startFakeAgentServer(fakeAgent, replay);
  const fakeAgentClient = {
    attachUrl: async () => server.url,
  } as unknown as AgentClientType;
  const dispatch = new AgentDispatch({
    agentClient: fakeAgentClient,
    notifier,
    onActivity,
  });
  return {
    dispatch,
    stop: () => {
      void dispatch.closeAll();
      server.stop();
    },
  };
}

const SANDBOX_ID = "sandbox-1";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
});

describe("AgentDispatch × session/list", () => {
  test("a session the server did not create appears when the agent supports session/list", async () => {
    const fakeAgent = new FakeAcpAgent();
    fakeAgent.seedSession("terminal-1", "/home/dev/project", "From terminal");
    const { dispatch, stop } = makeDispatch(fakeAgent);
    cleanups.push(stop);

    const sessions = await dispatch.sessionsFor(SANDBOX_ID);
    expect(sessions.map((s) => s.sessionId)).toContain("terminal-1");
    const found = sessions.find((s) => s.sessionId === "terminal-1");
    expect(found?.title).toBe("From terminal");
    expect(found?.directory).toBe("/home/dev/project");
  });

  test("busy overlay flips a listed session busy during a prompt and back", async () => {
    const fakeAgent = new FakeAcpAgent();
    fakeAgent.promptDelayMs = 60;
    const { dispatch, stop } = makeDispatch(fakeAgent);
    cleanups.push(stop);

    const session = await dispatch.openSession({
      sandboxId: SANDBOX_ID,
      cwd: "/home/dev/work",
    });

    const idleBefore = await dispatch.statusesFor(SANDBOX_ID);
    expect(idleBefore[session.sessionId]).toEqual({ type: "idle" });

    const promptPromise = session.prompt("do the thing");
    await new Promise((resolve) => setTimeout(resolve, 15));
    const duringPrompt = await dispatch.statusesFor(SANDBOX_ID);
    expect(duringPrompt[session.sessionId]).toEqual({ type: "busy" });

    await promptPromise;
    const afterPrompt = await dispatch.statusesFor(SANDBOX_ID);
    expect(afterPrompt[session.sessionId]).toEqual({ type: "idle" });
  });

  test("double close() releases the lifetime hold once, never a sibling's", async () => {
    const fakeAgent = new FakeAcpAgent();
    const { dispatch, stop } = makeDispatch(fakeAgent);
    cleanups.push(stop);
    const live = (
      dispatch as unknown as { live: Map<string, { holdCount: number }> }
    ).live;

    const a = await dispatch.openSession({
      sandboxId: SANDBOX_ID,
      cwd: "/home/dev/a",
    });
    // Second session keeps a hold on the shared connection.
    await dispatch.openSession({ sandboxId: SANDBOX_ID, cwd: "/home/dev/b" });
    const conn = live.get(SANDBOX_ID);
    expect(conn?.holdCount).toBe(2);

    await a.close();
    await a.close(); // idempotent: must NOT release b's hold
    expect(conn?.holdCount).toBe(1);
    expect(live.has(SANDBOX_ID)).toBe(true);
  });

  test("prompt fails fast when the owning connection was replaced", async () => {
    const fakeAgent = new FakeAcpAgent();
    const { dispatch, stop } = makeDispatch(fakeAgent);
    cleanups.push(stop);
    const live = (
      dispatch as unknown as { live: Map<string, { close(): void }> }
    ).live;

    const session = await dispatch.openSession({
      sandboxId: SANDBOX_ID,
      cwd: "/home/dev/work",
    });
    // Simulate a socket drop (acp restart): the owning connection tears down.
    live.get(SANDBOX_ID)?.close();

    await expect(session.prompt("hi")).rejects.toThrow(/no longer live/);
  });

  test("a redial ignores what the attach bridge replays from earlier connections", async () => {
    const fakeAgent = new FakeAcpAgent();
    fakeAgent.failNewSession = "Could not start pi";
    // What a server without per-connection ids left in the bridge buffer:
    // numeric ids this connection reuses, and a long-settled permission ask.
    const seed = [
      { jsonrpc: "2.0", id: 0, result: { protocolVersion: 1 } },
      { jsonrpc: "2.0", id: 1, result: { sessionId: "stale-session" } },
      {
        jsonrpc: "2.0",
        id: 0,
        method: "session/request_permission",
        params: {
          sessionId: "stale-session",
          toolCall: { toolCallId: "tc-0", title: "Old" },
          options: [{ optionId: "a", name: "Allow", kind: "allow_once" }],
        },
      },
    ]
      .map((m) => `${JSON.stringify(m)}\n`)
      .join("");
    const { dispatch, stop } = makeDispatch(fakeAgent, undefined, undefined, {
      seed,
    });
    cleanups.push(stop);
    const live = (dispatch as unknown as { live: Map<string, unknown> }).live;
    const open = () =>
      dispatch.openSession({ sandboxId: SANDBOX_ID, cwd: "/home/dev" });

    // The agent's real answer, not the stale success replayed ahead of it.
    await expect(open()).rejects.toThrow(/Could not start pi/);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(live.has(SANDBOX_ID)).toBe(false);

    // The redial gets the failure above replayed too; the fixed agent's
    // answer must win, and no replayed permission may surface as pending.
    fakeAgent.failNewSession = undefined;
    const session = await open();
    expect(session.sessionId).toBe("sess-1");
    expect(dispatch.permissionsFor(SANDBOX_ID)).toEqual([]);
  });

  test("resumeSessionId reopens the session with session/load, history unseen", async () => {
    const fakeAgent = new FakeAcpAgent();
    fakeAgent.seedSession("earlier", "/home/dev");
    const { dispatch, stop } = makeDispatch(fakeAgent);
    cleanups.push(stop);
    const updates: unknown[] = [];

    const session = await dispatch.openSession({
      sandboxId: SANDBOX_ID,
      cwd: "/home/dev",
      resumeSessionId: "earlier",
      callbacks: { onUpdate: (n) => updates.push(n) },
    });

    expect(session.sessionId).toBe("earlier");
    expect(session.live).toBe(true);
    expect(fakeAgent.loaded).toEqual(["earlier"]);
    expect(fakeAgent.sessions.size).toBe(1); // no new session
    expect(updates).toEqual([]); // the replayed history isn't new output
    expect((await session.prompt("go on")).stopReason).toBe("end_turn");
  });

  test("resumeSessionId on an agent without loadSession is a conflict", async () => {
    const fakeAgent = new FakeAcpAgent();
    fakeAgent.canLoad = false;
    fakeAgent.seedSession("earlier", "/home/dev");
    const { dispatch, stop } = makeDispatch(fakeAgent);
    cleanups.push(stop);

    await expect(
      dispatch.openSession({
        sandboxId: SANDBOX_ID,
        cwd: "/home/dev",
        resumeSessionId: "earlier",
      }),
    ).rejects.toThrow(/can't reopen a session/);
  });

  test("a handle stops being live once its connection is gone", async () => {
    const fakeAgent = new FakeAcpAgent();
    const { dispatch, stop } = makeDispatch(fakeAgent);
    cleanups.push(stop);
    const live = (
      dispatch as unknown as { live: Map<string, { close(): void }> }
    ).live;
    const session = await dispatch.openSession({
      sandboxId: SANDBOX_ID,
      cwd: "/home/dev",
    });
    expect(session.live).toBe(true);
    live.get(SANDBOX_ID)?.close();
    expect(session.live).toBe(false);
  });

  test("todos come from plan notifications; [] for sessions never driven", async () => {
    const fakeAgent = new FakeAcpAgent();
    fakeAgent.seedSession("terminal-2", "/home/dev/other");
    const { dispatch, stop } = makeDispatch(fakeAgent);
    cleanups.push(stop);

    const session = await dispatch.openSession({
      sandboxId: SANDBOX_ID,
      cwd: "/home/dev/work",
    });

    expect(await dispatch.todosFor(SANDBOX_ID, session.sessionId)).toEqual([]);

    await fakeAgent.emitPlan(session.sessionId, [
      { content: "step one", status: "pending", priority: "medium" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const todos = await dispatch.todosFor(SANDBOX_ID, session.sessionId);
    expect(todos).toEqual([
      { content: "step one", status: "pending", priority: "medium" },
    ]);

    // A listed-but-server-didn't-drive-it session has no todos.
    expect(await dispatch.todosFor(SANDBOX_ID, "terminal-2")).toEqual([]);
  });

  test("session_info_update overrides the listed title", async () => {
    const fakeAgent = new FakeAcpAgent();
    const { dispatch, stop } = makeDispatch(fakeAgent);
    cleanups.push(stop);

    const session = await dispatch.openSession({
      sandboxId: SANDBOX_ID,
      cwd: "/home/dev/work",
    });

    await fakeAgent.emitTitle(session.sessionId, "Renamed by agent");
    const found = await dispatch.sessionFor(SANDBOX_ID, session.sessionId);
    expect(found?.title).toBe("Renamed by agent");
  });

  test("idle activity: prompts and permission requests count, updates don't", async () => {
    const fakeAgent = new FakeAcpAgent();
    let touches = 0;
    const { dispatch, stop } = makeDispatch(fakeAgent, undefined, () => {
      touches++;
    });
    cleanups.push(stop);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

    const session = await dispatch.openSession({
      sandboxId: SANDBOX_ID,
      cwd: "/home/dev/work",
    });
    // Updates arriving outside a prompt (the attach bridge replays an old
    // turn's output on every reconnect) are not activity.
    await fakeAgent.emitPlan(session.sessionId, [
      { content: "old step", status: "completed", priority: "medium" },
    ]);
    await fakeAgent.emitTitle(session.sessionId, "Old title");
    await settle();
    expect(touches).toBe(0);

    await session.prompt("do the thing");
    expect(touches).toBe(2); // the turn starting and ending

    const permission = fakeAgent.requestPermission(session.sessionId);
    await settle();
    expect(touches).toBe(3);
    const [pending] = dispatch.permissionsFor(SANDBOX_ID);
    dispatch.replyPermission(SANDBOX_ID, pending?.id ?? "", "once");
    await permission;
  });

  test("retries once when the agent returns a null sessions on the first call", async () => {
    const fakeAgent = new FakeAcpAgent();
    fakeAgent.nullFirstList = true;
    fakeAgent.seedSession("terminal-9", "/home/dev", "From terminal");
    const { dispatch, stop } = makeDispatch(fakeAgent);
    cleanups.push(stop);

    // First list would get {sessions:null}; the retry returns the real page,
    // so the caller never sees the cold-start empty and never throws.
    const sessions = await dispatch.sessionsFor(SANDBOX_ID);
    expect(sessions.map((s) => s.sessionId)).toEqual(["terminal-9"]);
    expect(fakeAgent.listCallCount).toBeGreaterThanOrEqual(2);
  });

  test("todosFor is a lazy read: no live connection, no dial", async () => {
    const fakeAgent = new FakeAcpAgent();
    const { dispatch, stop } = makeDispatch(fakeAgent);
    cleanups.push(stop);
    const live = (dispatch as unknown as { live: Map<string, unknown> }).live;

    const todos = await dispatch.todosFor(SANDBOX_ID, "never-created");
    expect(todos).toEqual([]);
    // Reading todos must NOT open an ACP connection (Rule 5): todos live only
    // in the in-memory overlay of an already-live connection.
    expect(live.has(SANDBOX_ID)).toBe(false);
  });

  test("agents without session/list fall back to server-created ids only", async () => {
    const fakeAgent = new FakeAcpAgent();
    fakeAgent.canList = false;
    fakeAgent.seedSession("terminal-3", "/home/dev/other", "Not visible");
    const { dispatch, stop } = makeDispatch(fakeAgent);
    cleanups.push(stop);

    const created = await dispatch.createSession(SANDBOX_ID, "/home/dev/work");
    const sessions = await dispatch.sessionsFor(SANDBOX_ID);

    expect(sessions.map((s) => s.sessionId)).toEqual([created.sessionId]);
    expect(sessions.map((s) => s.sessionId)).not.toContain("terminal-3");
  });

  test("idle TTL closes the connection once the last hold releases; a pending permission keeps it open", async () => {
    const fakeAgent = new FakeAcpAgent();
    const { dispatch, stop } = makeDispatch(fakeAgent);
    cleanups.push(stop);

    const live = (dispatch as unknown as { live: Map<string, unknown> }).live;

    // Baseline: a read dials, holds, then releases — idle timer arms and
    // fires since nothing else keeps the connection open.
    await dispatch.sessionsFor(SANDBOX_ID);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(live.has(SANDBOX_ID)).toBe(false);

    // An open session holds the connection for its lifetime; close it so the
    // ONLY thing keeping the socket open is the pending permission below.
    const session = await dispatch.openSession({
      sandboxId: SANDBOX_ID,
      cwd: "/home/dev/work",
    });
    const permissionPromise = fakeAgent.requestPermission(session.sessionId);
    // Let the permission request land before we let the connection go idle.
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(dispatch.permissionsFor(SANDBOX_ID)).toHaveLength(1);
    await session.close();

    // The session hold is released, but the pending permission must still keep
    // the connection open past the idle TTL.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(live.has(SANDBOX_ID)).toBe(true);

    const permissions = dispatch.permissionsFor(SANDBOX_ID);
    expect(permissions).toHaveLength(1);
    dispatch.replyPermission(SANDBOX_ID, permissions[0]?.id ?? "", "once");
    await permissionPromise;

    // Nothing holds it now → idle-closes.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(live.has(SANDBOX_ID)).toBe(false);
  });
});

describe("AgentDispatch × permission notifier race", () => {
  /** Records every notify() call so a test can answer / inspect it. */
  function recordingNotifier() {
    const calls: {
      prompt: PermissionPrompt;
      answer: (optionId: string) => void;
      signal: AbortSignal;
    }[] = [];
    const notifier: PermissionNotifier = {
      notify: (prompt, answer, signal) => {
        calls.push({ prompt, answer, signal });
      },
    };
    return { calls, notifier };
  }

  async function pendingPrompt(
    fakeAgent: FakeAcpAgent,
    dispatch: AgentDispatchT,
  ) {
    const session = await dispatch.openSession({
      sandboxId: SANDBOX_ID,
      cwd: "/home/dev/work",
    });
    const answered = fakeAgent.requestPermission(session.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { session, answered };
  }
  type AgentDispatchT = InstanceType<typeof AgentDispatch>;

  test("the prompt carries requestId, kind and options; list is lossless", async () => {
    const fakeAgent = new FakeAcpAgent();
    const { calls, notifier } = recordingNotifier();
    const { dispatch, stop } = makeDispatch(fakeAgent, notifier);
    cleanups.push(stop);
    await pendingPrompt(fakeAgent, dispatch);

    const [pending] = dispatch.permissionsFor(SANDBOX_ID);
    expect(calls[0]?.prompt.requestId).toBe(pending?.id ?? "missing");
    expect(calls[0]?.prompt.kind).toBe("execute");
    expect(pending?.toolKind).toBe("execute");
    expect(pending?.options).toEqual([
      { optionId: "allow-once", name: "Allow", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ]);
  });

  test("a notifier answer settles the prompt", async () => {
    const fakeAgent = new FakeAcpAgent();
    const { calls, notifier } = recordingNotifier();
    const { dispatch, stop } = makeDispatch(fakeAgent, notifier);
    cleanups.push(stop);
    const { answered } = await pendingPrompt(fakeAgent, dispatch);

    calls[0]?.answer("reject-once");

    expect(await answered).toEqual({
      outcome: { outcome: "selected", optionId: "reject-once" },
    });
    expect(dispatch.permissionsFor(SANDBOX_ID)).toHaveLength(0);
    // Settled by the notifier itself: nothing to withdraw.
    expect(calls[0]?.signal.aborted).toBe(false);
  });

  test("a console reply aborts the notifier signal", async () => {
    const fakeAgent = new FakeAcpAgent();
    const { calls, notifier } = recordingNotifier();
    const { dispatch, stop } = makeDispatch(fakeAgent, notifier);
    cleanups.push(stop);
    const { answered } = await pendingPrompt(fakeAgent, dispatch);

    const id = dispatch.permissionsFor(SANDBOX_ID)[0]?.id ?? "";
    expect(dispatch.replyPermission(SANDBOX_ID, id, "once")).toEqual({
      ok: true,
    });

    expect(calls[0]?.signal.aborted).toBe(true);
    expect(await answered).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  });

  test("closing the connection aborts the notifier signal", async () => {
    const fakeAgent = new FakeAcpAgent();
    const { calls, notifier } = recordingNotifier();
    const { dispatch, stop } = makeDispatch(fakeAgent, notifier);
    cleanups.push(stop);
    const { session } = await pendingPrompt(fakeAgent, dispatch);
    expect(calls[0]?.signal.aborted).toBe(false);

    await session.close();
    await dispatch.closeAll();

    expect(calls[0]?.signal.aborted).toBe(true);
  });

  test("an optionId the agent did not offer is rejected (400)", async () => {
    const fakeAgent = new FakeAcpAgent();
    const { dispatch, stop } = makeDispatch(fakeAgent);
    cleanups.push(stop);
    await pendingPrompt(fakeAgent, dispatch);
    const id = dispatch.permissionsFor(SANDBOX_ID)[0]?.id ?? "";

    let thrown: unknown;
    try {
      dispatch.replyPermission(SANDBOX_ID, id, { optionId: "nope" });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { statusCode?: number }).statusCode).toBe(400);
    // Still pending; an offered option works.
    expect(dispatch.permissionsFor(SANDBOX_ID)).toHaveLength(1);
    expect(
      dispatch.replyPermission(SANDBOX_ID, id, { optionId: "allow-once" }),
    ).toEqual({ ok: true });
  });

  test("a notifier answer after the prompt settled is ignored", async () => {
    const fakeAgent = new FakeAcpAgent();
    const { calls, notifier } = recordingNotifier();
    const { dispatch, stop } = makeDispatch(fakeAgent, notifier);
    cleanups.push(stop);
    const { answered } = await pendingPrompt(fakeAgent, dispatch);
    const id = dispatch.permissionsFor(SANDBOX_ID)[0]?.id ?? "";

    dispatch.replyPermission(SANDBOX_ID, id, "once");
    calls[0]?.answer("reject-once");

    expect(await answered).toEqual({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    expect(dispatch.permissionsFor(SANDBOX_ID)).toHaveLength(0);
  });

  test("a notifier answer with an unoffered optionId is ignored", async () => {
    const fakeAgent = new FakeAcpAgent();
    const { calls, notifier } = recordingNotifier();
    const { dispatch, stop } = makeDispatch(fakeAgent, notifier);
    cleanups.push(stop);
    await pendingPrompt(fakeAgent, dispatch);

    calls[0]?.answer("nope");

    expect(dispatch.permissionsFor(SANDBOX_ID)).toHaveLength(1);
  });
});
