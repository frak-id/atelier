/**
 * The agent-task MCP tools driven end to end through a real MCP client/server
 * pair (in-memory transport): argument validation, the seconds→ms wait
 * conversion, error mapping, and per-user scoping. Task mechanics are covered
 * in `sessions/task.service.test.ts`; this is the binding.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthUser } from "../../../control/index.ts";
// Not the `sessions` barrel: it loads `agent-dispatch.ts`, whose idle TTL is
// fixed at first load and must stay under `agent-dispatch.test.ts`'s control.
import { AgentTaskService } from "../../../sessions/task.service.ts";
import {
  makeFake,
  SANDBOX,
  SESSION,
} from "../../../sessions/task.test-support.ts";
import type { ServerContainer } from "../../container.ts";
import { registerTaskTools } from "./tasks.ts";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

/** One MCP client bound to `userId`, over a (possibly shared) task service. */
async function connect(tasks: AgentTaskService, userId: string) {
  const server = new McpServer({ name: "test", version: "0" });
  registerTaskTools(
    server,
    { tasks } as unknown as ServerContainer,
    { id: userId } as AuthUser,
  );
  const client = new Client({ name: "test-client", version: "0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });

  return async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const [block] = result.content as { type: string; text: string }[];
    return {
      isError: result.isError === true,
      data: JSON.parse(block?.text ?? "null"),
    };
  };
}

function setup() {
  const fake = makeFake();
  const tasks = new AgentTaskService(fake.deps);
  cleanups.push(() => tasks.closeAll());
  return { fake, tasks };
}

describe("agent task tools", () => {
  test("registers the six task tools", async () => {
    const { tasks } = setup();
    const server = new McpServer({ name: "test", version: "0" });
    registerTaskTools(
      server,
      { tasks } as unknown as ServerContainer,
      { id: "u" } as AuthUser,
    );
    const client = new Client({ name: "c", version: "0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "dispatch_task",
      "get_task",
      "list_tasks",
      "manage_task",
      "reply_permission",
      "send_prompt",
    ]);
  });

  test("dispatch → poll → follow-up → close", async () => {
    const { fake, tasks } = setup();
    const call = await connect(tasks, "user-1");

    const dispatched = await call("dispatch_task", {
      sandboxId: SANDBOX,
      prompt: "summarise the repo",
    });
    expect(dispatched.isError).toBe(false);
    expect(dispatched.data).toMatchObject({
      sandboxId: SANDBOX,
      sessionId: SESSION,
      status: "running",
    });
    const taskId = dispatched.data.taskId as string;

    // Long-poll: the 1s wait must return as soon as the turn finishes.
    setTimeout(() => {
      fake.say("It is a monorepo.");
      fake.finish();
    }, 30);
    const started = Date.now();
    const done = await call("get_task", { taskId, waitSeconds: 5 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(done.data.status).toBe("idle");
    expect(done.data.turn.reply).toBe("It is a monorepo.");

    // Follow-up on the same task, waiting inline for the answer.
    setTimeout(() => {
      fake.say("Yes, with Bun.");
      fake.finish();
    }, 30);
    const followUp = await call("send_prompt", {
      taskId,
      prompt: "uses bun?",
      waitSeconds: 5,
    });
    expect(followUp.data.turn).toMatchObject({
      index: 1,
      status: "completed",
      reply: "Yes, with Bun.",
    });

    const listed = await call("list_tasks", { sandboxId: SANDBOX });
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({ taskId, turns: 2, status: "idle" });

    expect(await call("manage_task", { taskId, action: "close" })).toEqual({
      isError: false,
      data: { ok: true },
    });
    expect(fake.state.closed).toBe(1);
    expect((await call("list_tasks", {})).data).toEqual([]);
  });

  test("a permission request surfaces and reply_permission answers it", async () => {
    const { fake, tasks } = setup();
    const call = await connect(tasks, "user-1");
    const { data } = await call("dispatch_task", {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    fake.askPermission("perm-1");

    const blocked = await call("get_task", { taskId: data.taskId });
    expect(blocked.data.status).toBe("waiting_permission");
    expect(blocked.data.pendingPermissions[0]).toMatchObject({ id: "perm-1" });

    const answered = await call("reply_permission", {
      taskId: data.taskId,
      requestId: "perm-1",
      reply: "once",
    });
    expect(answered.data.status).toBe("running");
    expect(fake.replies).toEqual([{ id: "perm-1", reply: "once" }]);
  });

  test("manage_task cancel stops the turn", async () => {
    const { tasks } = setup();
    const call = await connect(tasks, "user-1");
    const { data } = await call("dispatch_task", {
      sandboxId: SANDBOX,
      prompt: "x",
    });

    const cancelled = await call("manage_task", {
      taskId: data.taskId,
      action: "cancel",
    });
    expect(cancelled.data.status).toBe("cancelled");
  });

  test("errors come back as isError results, not protocol failures", async () => {
    const { tasks } = setup();
    const call = await connect(tasks, "user-1");

    const missing = await call("get_task", { taskId: "tsk_nope" });
    expect(missing.isError).toBe(true);
    expect(missing.data).toMatchObject({ error: "NOT_FOUND" });

    const { data } = await call("dispatch_task", {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    const busy = await call("send_prompt", {
      taskId: data.taskId,
      prompt: "again",
    });
    expect(busy.isError).toBe(true);
    expect(busy.data).toMatchObject({ error: "CONFLICT" });
  });

  test("rejects out-of-range arguments", async () => {
    const { tasks } = setup();
    const call = await connect(tasks, "user-1");

    // Depending on SDK version bad input is an isError result or a thrown
    // protocol error; either way the call must not succeed.
    const outcome = await call("dispatch_task", {
      sandboxId: SANDBOX,
      prompt: "x",
      waitSeconds: 999,
    }).then(
      (r) => r.isError,
      () => true,
    );
    expect(outcome).toBe(true);
    expect(tasks.list("user-1")).toEqual([]);
  });

  test("tasks are scoped to the authenticated user", async () => {
    const { tasks } = setup();
    const alice = await connect(tasks, "alice");
    const mallory = await connect(tasks, "mallory");

    const { data } = await alice("dispatch_task", {
      sandboxId: SANDBOX,
      prompt: "private work",
    });

    const peek = await mallory("get_task", { taskId: data.taskId });
    expect(peek.isError).toBe(true);
    expect(peek.data).toMatchObject({ error: "NOT_FOUND" });
    expect(
      (await mallory("manage_task", { taskId: data.taskId, action: "close" }))
        .isError,
    ).toBe(true);
    expect((await mallory("list_tasks", {})).data).toEqual([]);
    expect((await alice("list_tasks", {})).data).toHaveLength(1);
  });
});
