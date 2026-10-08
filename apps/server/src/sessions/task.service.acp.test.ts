/**
 * AgentTaskService on the REAL `AgentDispatch` + ACP SDK, against a fake ACP
 * agent served over a WebSocket (same approach as `acp/agent-dispatch.test.ts`).
 * `task.service.test.ts` stubs the dispatch for logic; this file proves the
 * wiring the stub can't: real `session/update` notifications reach the task's
 * reply capture, and a real `session/request_permission` round-trips through
 * `autoApprove` / `replyPermission`.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  type AgentContext,
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type { ServerWebSocket } from "bun";
import type { AgentClient } from "../runtime/index.ts";
import { AgentTaskService } from "./task.service.ts";

// `agent-dispatch.ts` reads ACP_IDLE_TTL_MS once, at module load, and bun
// shares one module cache across test files. `acp/agent-dispatch.test.ts`
// needs the short TTL, so whichever file loads the module first must set it:
// same value, set before a DYNAMIC import (static imports are hoisted above
// this line), so test-file order can't change the outcome.
process.env.ACP_IDLE_TTL_MS = "40";

let AgentDispatch: typeof import("./acp/agent-dispatch.ts").AgentDispatch;

beforeAll(async () => {
  ({ AgentDispatch } = await import("./acp/agent-dispatch.ts"));
});

const OWNER = "user-1";
const SANDBOX = "sbx-acp";

/** Scripted agent: on `session/prompt` it narrates, calls a "tool", asks
 * permission, then reports which option the client picked. */
class ScriptedAgent {
  clientCtx?: AgentContext;
  private nextId = 1;
  /** Prompt text → resolves when the test releases the turn. */
  readonly gates = new Map<string, () => void>();

  get app() {
    return agent()
      .onRequest(methods.agent.initialize, (ctx) => {
        this.clientCtx = ctx.client;
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { sessionCapabilities: { list: {}, close: {} } },
        };
      })
      .onRequest(methods.agent.session.new, () => ({
        sessionId: `acp-sess-${this.nextId++}`,
      }))
      .onRequest(methods.agent.session.list, () => ({ sessions: [] }))
      .onRequest(methods.agent.session.close, () => ({}))
      .onRequest(methods.agent.session.prompt, async (ctx) => {
        const { sessionId, prompt } = ctx.params;
        const first = prompt[0];
        const text = first?.type === "text" ? first.text : "";
        const client = this.clientCtx;
        if (!client) throw new Error("no client");
        const say = (chunk: string, messageId: string) =>
          client.notify(methods.client.session.update, {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: chunk },
              messageId,
            },
          });

        await say("Looking around. ", "m1");
        await client.notify(methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-1",
            title: "Run ls",
            status: "in_progress",
          },
        });

        if (text.includes("needs-permission")) {
          const answer = await client.request(
            methods.client.session.requestPermission,
            {
              sessionId,
              toolCall: { toolCallId: "tc-1", title: "Run ls" },
              options: [
                { optionId: "allow-1", name: "Allow", kind: "allow_once" },
                { optionId: "reject-1", name: "Deny", kind: "reject_once" },
              ],
            },
          );
          const picked =
            answer.outcome.outcome === "selected"
              ? answer.outcome.optionId
              : "cancelled";
          await say(`permission:${picked}`, "m2");
        } else {
          await say(`echo:${text}`, "m2");
        }
        return { stopReason: "end_turn" as const };
      });
  }
}

interface FakeServer {
  url: string;
  stop: () => void;
}

function serve(fake: ScriptedAgent): FakeServer {
  const controllers = new WeakMap<
    ServerWebSocket<unknown>,
    ReadableStreamDefaultController<Uint8Array>
  >();
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
        void fake.app
          .connect(ndJsonStream(writable, readable))
          .closed.catch(() => {});
      },
      message(ws, message) {
        const bytes =
          typeof message === "string"
            ? new TextEncoder().encode(message)
            : new Uint8Array(message);
        controllers.get(ws)?.enqueue(bytes);
      },
      close(ws) {
        controllers.get(ws)?.close();
      },
    },
  });
  return {
    url: `ws://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  // Registration order = teardown order: tasks close their sessions while
  // the fake agent is still up, then the hub, then the server.
  for (const fn of cleanups.splice(0)) await fn();
});

function setup() {
  const fake = new ScriptedAgent();
  const server = serve(fake);
  const dispatch = new AgentDispatch({
    agentClient: {
      attachUrl: async () => server.url,
    } as unknown as AgentClient,
  });
  const tasks = new AgentTaskService({
    dispatch,
    runtime: {
      get: async () => ({
        id: SANDBOX,
        status: "running",
        annotations: { "atelier.dev/harness": "opencode" },
      }),
    } as unknown as ConstructorParameters<
      typeof AgentTaskService
    >[0]["runtime"],
  });
  cleanups.push(
    () => tasks.closeAll(),
    () => dispatch.closeAll(),
    () => server.stop(),
  );
  return { tasks };
}

describe("AgentTaskService over real ACP", () => {
  test("streamed agent text becomes the task reply, across turns", async () => {
    const { tasks } = setup();

    const started = await tasks.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "hello",
    });
    expect(started.sessionId).toStartWith("acp-sess-");

    const done = await tasks.get(OWNER, started.taskId, {
      waitMs: 10_000,
      full: true,
    });
    expect(done.status).toBe("idle");
    expect(done.turn.stopReason).toBe("end_turn");
    expect(done.turn.segments).toEqual(["Looking around. ", "echo:hello"]);
    expect(done.turn.reply).toBe("echo:hello");
    expect(done.turn.toolCalls).toEqual([
      { id: "tc-1", title: "Run ls", status: "in_progress" },
    ]);

    await tasks.sendPrompt(OWNER, started.taskId, "again");
    const second = await tasks.get(OWNER, started.taskId, { waitMs: 10_000 });
    expect(second.turn).toMatchObject({ index: 1, reply: "echo:again" });
    expect(second.turns).toHaveLength(2);
  });

  test("autoApprove answers a real permission request", async () => {
    const { tasks } = setup();
    const { taskId } = await tasks.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "needs-permission",
      autoApprove: true,
    });

    const done = await tasks.get(OWNER, taskId, { waitMs: 10_000 });

    expect(done.status).toBe("idle");
    expect(done.turn.reply).toBe("permission:allow-1");
    expect(done.pendingPermissions).toEqual([]);
  });

  test("without autoApprove the task blocks until replyPermission", async () => {
    const { tasks } = setup();
    const { taskId } = await tasks.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "needs-permission",
    });

    const blocked = await tasks.get(OWNER, taskId, { waitMs: 10_000 });
    expect(blocked.status).toBe("waiting_permission");
    expect(blocked.pendingPermissions).toHaveLength(1);
    expect(blocked.pendingPermissions[0]?.permission).toBe("Run ls");

    const requestId = blocked.pendingPermissions[0]?.id ?? "";
    await tasks.replyPermission(OWNER, taskId, requestId, "reject");

    const done = await tasks.get(OWNER, taskId, { waitMs: 10_000 });
    expect(done.status).toBe("idle");
    expect(done.turn.reply).toBe("permission:reject-1");
  });

  test("cancelling while blocked on a permission unblocks the agent", async () => {
    const { tasks } = setup();
    const { taskId } = await tasks.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "needs-permission",
    });
    const blocked = await tasks.get(OWNER, taskId, { waitMs: 10_000 });
    expect(blocked.status).toBe("waiting_permission");

    // The scripted agent ignores `session/cancel`, but the pending request is
    // answered (rejected) so it is no longer stuck on it and finishes.
    await tasks.cancel(OWNER, taskId);
    const done = await tasks.get(OWNER, taskId, { waitMs: 10_000 });
    expect(done.pendingPermissions).toEqual([]);
    expect(done.turn.reply).toBe("permission:reject-1");
  });
});
