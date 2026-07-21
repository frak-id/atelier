/**
 * AgentDispatch against a fake ACP agent (no real sandbox/attach bridge): a
 * Bun WebSocket server wired to an `agent()` app from the SDK. Exercises the
 * `session/list`-backed surface, the busy/todos/title overlays, the
 * capability-gated fallback for agents without `session/list`, and the
 * hold/idle-TTL connection lifecycle.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";

process.env.ACP_IDLE_TTL_MS = "40";

let AgentDispatch: typeof import("./agent-dispatch.ts").AgentDispatch;
let agent: typeof import("@agentclientprotocol/sdk").agent;
let methods: typeof import("@agentclientprotocol/sdk").methods;
let ndJsonStream: typeof import("@agentclientprotocol/sdk").ndJsonStream;
let PROTOCOL_VERSION: typeof import("@agentclientprotocol/sdk").PROTOCOL_VERSION;
type AgentContext = import("@agentclientprotocol/sdk").AgentContext;
type AgentClientType = import("../../runtime/index.ts").AgentClient;

beforeAll(async () => {
  // ACP_IDLE_TTL_MS is read once at module load, so set it before importing.
  ({ AgentDispatch } = await import("./agent-dispatch.ts"));
  ({ agent, methods, ndJsonStream, PROTOCOL_VERSION } = await import(
    "@agentclientprotocol/sdk"
  ));
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
            sessionCapabilities: {
              list: this.canList ? {} : undefined,
              close: this.canClose ? {} : undefined,
            },
          },
        };
      })
      .onRequest(methods.agent.session.new, (ctx) => {
        const sessionId = `sess-${this.nextId++}`;
        this.sessions.set(sessionId, { sessionId, cwd: ctx.params.cwd });
        return { sessionId };
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
      toolCall: { toolCallId: "tc-1", title: "Run a thing" },
      options: [{ optionId: "allow-once", name: "Allow", kind: "allow_once" }],
    });
  }
}

interface FakeServer {
  url: string;
  closed: () => boolean;
  stop: () => void;
}

function startFakeAgentServer(fakeAgent: FakeAcpAgent): FakeServer {
  const controllers = new WeakMap<
    ServerWebSocket<unknown>,
    ReadableStreamDefaultController<Uint8Array>
  >();
  let sawClose = false;
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("expected websocket", { status: 400 });
    },
    websocket: {
      open(ws) {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const readable = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        });
        const writable = new WritableStream<Uint8Array>({
          write(chunk) {
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

function makeDispatch(fakeAgent: FakeAcpAgent): {
  dispatch: InstanceType<typeof AgentDispatch>;
  stop: () => void;
} {
  const server = startFakeAgentServer(fakeAgent);
  const fakeAgentClient = {
    attachUrl: async () => server.url,
  } as unknown as AgentClientType;
  const dispatch = new AgentDispatch({ agentClient: fakeAgentClient });
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
