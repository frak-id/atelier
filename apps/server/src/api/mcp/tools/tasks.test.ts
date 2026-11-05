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
    {
      tasks,
      runtime: { getLabels: () => ({ metadata: {}, annotations: {} }) },
      control: { canAccessSandbox: () => true },
    } as unknown as ServerContainer,
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
  test("registers the three task tools", async () => {
    const { tasks } = setup();
    const server = new McpServer({ name: "test", version: "0" });
    registerTaskTools(
      server,
      {
        tasks,
        runtime: { getLabels: () => ({ metadata: {}, annotations: {} }) },
        control: { canAccessSandbox: () => true },
      } as unknown as ServerContainer,
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
      "get_task",
      "manage_task",
      "send_prompt",
    ]);
  });

  test("start → poll → follow-up → list → close", async () => {
    const { fake, tasks } = setup();
    const call = await connect(tasks, "user-1");

    const dispatched = await call("send_prompt", {
      sandboxId: SANDBOX,
      prompt: "summarise the repo",
    });
    expect(dispatched.isError).toBe(false);
    expect(dispatched.data).toMatchObject({
      sandboxId: SANDBOX,
      status: "running",
      turnCount: 1,
    });
    // The summary view leaves internal ids and echoed input out.
    expect(dispatched.data).not.toHaveProperty("sessionId");
    expect(dispatched.data).not.toHaveProperty("cwd");
    expect(dispatched.data.turn).not.toHaveProperty("prompt");
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

    const listed = await call("get_task", { sandboxId: SANDBOX });
    expect(listed.data.tasks).toHaveLength(1);
    expect(listed.data.tasks[0]).toMatchObject({
      taskId,
      turnCount: 2,
      status: "idle",
    });
    expect(listed.data.tasks[0]).not.toHaveProperty("sessionId");
    expect((await call("get_task", { status: "running" })).data).toEqual({
      tasks: [],
    });

    expect(await call("manage_task", { taskId, action: "close" })).toEqual({
      isError: false,
      data: { taskId, status: "closed" },
    });
    expect(fake.state.closed).toBe(1);
    expect((await call("get_task", {})).data).toEqual({ tasks: [] });
  });

  test("a running turn reports progress, not a reply", async () => {
    const { fake, tasks } = setup();
    const call = await connect(tasks, "user-1");
    const { data } = await call("send_prompt", {
      sandboxId: SANDBOX,
      prompt: "x",
    });

    fake.say("looking at the repo");
    const running = await call("get_task", { taskId: data.taskId });
    expect(running.data.status).toBe("running");
    expect(running.data.turn.progress).toBe("looking at the repo");
    expect(running.data.turn).not.toHaveProperty("reply");

    fake.finish();
    const done = await call("get_task", { taskId: data.taskId });
    expect(done.data.turn.reply).toBe("looking at the repo");
    expect(done.data.turn).not.toHaveProperty("progress");
  });

  test("view=full adds the transcript; maxChars bounds the reply", async () => {
    const { fake, tasks } = setup();
    const call = await connect(tasks, "user-1");
    const { data } = await call("send_prompt", {
      sandboxId: SANDBOX,
      prompt: "explain",
    });
    fake.say(`${"a".repeat(500)}END`);
    fake.finish();

    const cut = await call("get_task", { taskId: data.taskId, maxChars: 100 });
    expect(cut.data.turn.truncated).toBe(true);
    expect(cut.data.turn.reply).toContain("earlier chars truncated");
    expect(cut.data.turn.reply.endsWith("END")).toBe(true);

    const full = await call("get_task", { taskId: data.taskId, view: "full" });
    expect(full.data).toMatchObject({
      sessionId: SESSION,
      turn: { prompt: "explain" },
    });
    expect(full.data.turn.segments).toHaveLength(1);
    expect(full.data.turn).not.toHaveProperty("reply");
  });

  test("manage_task cancel stops the turn", async () => {
    const { tasks } = setup();
    const call = await connect(tasks, "user-1");
    const { data } = await call("send_prompt", {
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

    const { data } = await call("send_prompt", {
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
    const outcome = await call("send_prompt", {
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

    const { data } = await alice("send_prompt", {
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
    expect((await mallory("get_task", {})).data).toEqual({ tasks: [] });
    expect((await alice("get_task", {})).data).toHaveLength(1);
  });

  test("send_prompt needs exactly one of sandboxId and taskId", async () => {
    const { tasks } = setup();
    const call = await connect(tasks, "user-1");

    const neither = await call("send_prompt", { prompt: "x" });
    expect(neither.isError).toBe(true);
    expect(neither.data).toMatchObject({ error: "VALIDATION_ERROR" });

    const { data } = await call("send_prompt", {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    const both = await call("send_prompt", {
      sandboxId: SANDBOX,
      taskId: data.taskId,
      prompt: "again",
    });
    expect(both.isError).toBe(true);
    expect(both.data).toMatchObject({ error: "VALIDATION_ERROR" });
    // Neither mistaken call started a second task or a second turn.
    expect(tasks.list("user-1")).toHaveLength(1);
    expect(tasks.list("user-1")[0]?.turns).toBe(1);
  });

  test("new-task options are rejected when continuing a task", async () => {
    const { fake, tasks } = setup();
    const call = await connect(tasks, "user-1");
    const { data } = await call("send_prompt", {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    fake.finish();

    const res = await call("send_prompt", {
      taskId: data.taskId,
      prompt: "more",
      cwd: "/tmp",
    });
    expect(res.isError).toBe(true);
    expect(res.data).toMatchObject({ error: "VALIDATION_ERROR" });
    expect(res.data.message).toContain("`cwd`");
    expect(tasks.list("user-1")[0]?.turns).toBe(1);
  });

  test("get_task lists without taskId and rejects params of the other mode", async () => {
    const { tasks } = setup();
    const call = await connect(tasks, "user-1");
    const { data } = await call("send_prompt", {
      sandboxId: SANDBOX,
      prompt: "x",
    });

    const listView = await call("get_task", { view: "full" });
    expect(listView.isError).toBe(true);
    expect(listView.data).toMatchObject({ error: "VALIDATION_ERROR" });
    expect(listView.data.message).toContain("`view`");

    const readFilter = await call("get_task", {
      taskId: data.taskId,
      status: "idle",
    });
    expect(readFilter.isError).toBe(true);
    expect(readFilter.data).toMatchObject({ error: "VALIDATION_ERROR" });
    expect(readFilter.data.message).toContain("`status`");

    // The valid forms still work after the rejected ones.
    expect((await call("get_task", { status: "running" })).data).toHaveLength(
      1,
    );
    expect((await call("get_task", { taskId: data.taskId })).isError).toBe(
      false,
    );
  });

  test("manage_task only offers cancel and close", async () => {
    const { tasks } = setup();
    const call = await connect(tasks, "user-1");
    const { data } = await call("send_prompt", {
      sandboxId: SANDBOX,
      prompt: "x",
    });

    // Depending on SDK version an unknown enum value is an isError result
    // or a thrown protocol error; either way the call must not succeed.
    const outcome = await call("manage_task", {
      taskId: data.taskId,
      action: "reply_permission",
    }).then(
      (r) => r.isError,
      () => true,
    );
    expect(outcome).toBe(true);
    expect((await call("get_task", { taskId: data.taskId })).data.status).toBe(
      "running",
    );
  });
});
