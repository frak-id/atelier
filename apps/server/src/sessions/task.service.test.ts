/**
 * AgentTaskService behaviour against the stubbed dispatch in
 * `task.test-support.ts`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  ConflictError,
  NotFoundError,
  ResourceExhaustedError,
  ValidationError,
} from "../shared/errors.ts";
import { AgentTaskService, type AgentTaskServiceDeps } from "./task.service.ts";
import { makeFake, OWNER, SANDBOX, SESSION } from "./task.test-support.ts";

const services: AgentTaskService[] = [];
function makeService(
  fake: ReturnType<typeof makeFake>,
  extra: Partial<AgentTaskServiceDeps> = {},
) {
  const service = new AgentTaskService({ ...fake.deps, ...extra });
  services.push(service);
  return service;
}

/** Let queued microtasks (the background turn's settle path) run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.closeAll()));
});

describe("dispatchTask", () => {
  test("returns immediately, running, with the prompt in flight", async () => {
    const fake = makeFake();
    const service = makeService(fake);

    const view = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "fix the bug",
    });

    expect(view.status).toBe("running");
    expect(view.taskId).toStartWith("tsk_");
    expect(view.sessionId).toBe(SESSION);
    expect(view.turn).toMatchObject({ index: 0, status: "running" });
    expect(fake.prompts.map((p) => p.text)).toEqual(["fix the bug"]);
    expect(fake.opened[0]).toMatchObject({
      sandboxId: SANDBOX,
      cwd: "/home/dev",
      harnessId: "opencode",
    });
  });

  test("honours an explicit cwd", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
      cwd: "/home/dev/app",
    });
    expect(fake.opened[0]?.cwd).toBe("/home/dev/app");
  });

  test("rejects a sandbox that is not running", async () => {
    const service = makeService(makeFake({ status: "paused" }));
    const err = await service
      .dispatchTask(OWNER, { sandboxId: SANDBOX, prompt: "x" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toContain("paused");
  });

  test("rejects a sandbox without an agent harness", async () => {
    const service = makeService(makeFake({ annotations: undefined }));
    await expect(
      service.dispatchTask(OWNER, { sandboxId: SANDBOX, prompt: "x" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("rejects an empty prompt", async () => {
    const service = makeService(makeFake());
    await expect(
      service.dispatchTask(OWNER, { sandboxId: SANDBOX, prompt: "  \n" }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("caps tasks per owner", async () => {
    const fake = makeFake();
    const service = makeService(fake, { maxTasksPerOwner: 2 });
    for (let i = 0; i < 2; i++) {
      await service.dispatchTask(OWNER, { sandboxId: SANDBOX, prompt: "x" });
    }
    await expect(
      service.dispatchTask(OWNER, { sandboxId: SANDBOX, prompt: "x" }),
    ).rejects.toBeInstanceOf(ResourceExhaustedError);
    // The cap is per owner, not global.
    await service.dispatchTask("user-2", { sandboxId: SANDBOX, prompt: "x" });
  });
});

describe("reply capture", () => {
  test("a finished turn is idle and exposes the concluding message", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });

    fake.say("Let me look at the repo. ");
    fake.toolCall("tc-1", "Read package.json", "in_progress");
    fake.toolCallDone("tc-1");
    fake.say("All done: ");
    fake.say("fixed it.");
    fake.finish();
    await tick();

    const view = await service.get(OWNER, taskId);
    expect(view.status).toBe("idle");
    expect(view.turn.status).toBe("completed");
    expect(view.turn.stopReason).toBe("end_turn");
    expect(view.turn.reply).toBe("All done: fixed it.");
    expect(view.turn.segments).toBeUndefined();
    expect(view.turn.endedAt).toBeDefined();
    expect(view.turn.toolCalls).toEqual([
      { id: "tc-1", title: "Read package.json", status: "completed" },
    ]);

    const full = await service.get(OWNER, taskId, { full: true });
    expect(full.turn.segments).toEqual([
      "Let me look at the repo. ",
      "All done: fixed it.",
    ]);
  });

  test("a messageId change starts a new segment", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });

    fake.say("first", "m1");
    fake.say(" part", "m1");
    fake.say("second", "m2");
    fake.finish();
    await tick();

    const view = await service.get(OWNER, taskId, { full: true });
    expect(view.turn.segments).toEqual(["first part", "second"]);
    expect(view.turn.reply).toBe("second");
  });

  test("partial text is readable while the turn is still running", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    fake.say("working on it");

    const view = await service.get(OWNER, taskId);
    expect(view.status).toBe("running");
    expect(view.turn.reply).toBe("working on it");
    expect(view.turn.endedAt).toBeUndefined();
  });

  test("tool calls are bounded to the most recent ones", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    for (let i = 0; i < 15; i++) fake.toolCall(`tc-${i}`, `step ${i}`);

    const { turn } = await service.get(OWNER, taskId);
    expect(turn.toolCalls).toHaveLength(10);
    expect(turn.toolCalls[0]?.id).toBe("tc-5");
    expect(turn.toolCalls.at(-1)?.id).toBe("tc-14");
  });

  test("oversized replies drop the oldest text and flag truncation", async () => {
    const fake = makeFake();
    const service = makeService(fake, { maxReplyChars: 20 });
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });

    fake.say("a".repeat(15), "m1");
    fake.say("b".repeat(15), "m2"); // 30 > 20 → m1 dropped
    let view = await service.get(OWNER, taskId, { full: true });
    expect(view.turn.segments).toEqual(["b".repeat(15)]);
    expect(view.turn.truncated).toBe(true);

    fake.say("c".repeat(30), "m2"); // one segment alone over the cap → tail
    view = await service.get(OWNER, taskId, { full: true });
    expect(view.turn.reply).toHaveLength(20);
    expect(view.turn.reply.endsWith("c".repeat(20))).toBe(true);
  });

  test("updates for another session or after the turn are ignored", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    fake.say("real");
    fake.finish();
    await tick();
    fake.say(" late chunk"); // turn already over

    const view = await service.get(OWNER, taskId);
    expect(view.turn.reply).toBe("real");
  });
});

describe("get with waitMs", () => {
  test("returns as soon as the turn finishes", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });

    const started = Date.now();
    const pending = service.get(OWNER, taskId, { waitMs: 5_000 });
    setTimeout(() => {
      fake.say("done");
      fake.finish();
    }, 30);
    const view = await pending;

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(view.status).toBe("idle");
    expect(view.turn.reply).toBe("done");
  });

  test("returns the running state when the deadline passes first", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });

    const started = Date.now();
    const view = await service.get(OWNER, taskId, { waitMs: 60 });

    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect(view.status).toBe("running");
  });

  test("returns early when the agent needs a permission decision", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });

    const pending = service.get(OWNER, taskId, { waitMs: 5_000 });
    setTimeout(() => fake.askPermission(), 30);
    const view = await pending;

    expect(view.status).toBe("waiting_permission");
    expect(view.pendingPermissions).toEqual([
      { id: "perm-1", sessionId: SESSION, permission: "Run a command" },
    ]);
  });
});

describe("permissions", () => {
  test("replyPermission answers the request and the turn resumes", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    fake.askPermission("perm-1");

    const view = await service.replyPermission(
      OWNER,
      taskId,
      "perm-1",
      "always",
    );

    expect(fake.replies).toEqual([{ id: "perm-1", reply: "always" }]);
    expect(view.pendingPermissions).toEqual([]);
    expect(view.status).toBe("running");
  });

  test("cannot answer a request that belongs to another session", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    fake.askPermission("foreign", "someone-elses-session");

    await expect(
      service.replyPermission(OWNER, taskId, "foreign", "once"),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(fake.replies).toEqual([]);
    // ...and it doesn't count toward this task's status either.
    expect((await service.get(OWNER, taskId)).status).toBe("running");
  });

  test("an unknown request id is NotFound", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    await expect(
      service.replyPermission(OWNER, taskId, "nope", "once"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("autoApprove allows each request once, only for its own session", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
      autoApprove: true,
    });

    fake.askPermission("perm-1");
    fake.askPermission("perm-2");
    fake.askPermission("foreign", "someone-elses-session");

    expect(fake.replies).toEqual([
      { id: "perm-1", reply: "once" },
      { id: "perm-2", reply: "once" },
    ]);
    expect(fake.permissions.map((p) => p.id)).toEqual(["foreign"]);
    expect((await service.get(OWNER, taskId)).autoApprove).toBe(true);
  });
});

describe("sendPrompt", () => {
  test("is rejected while a turn is in flight", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "one",
    });
    const err = await service.sendPrompt(OWNER, taskId, "two").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toContain("running");
    expect(fake.prompts).toHaveLength(1);
  });

  test("starts a new turn once idle, and earlier turns stay readable", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "one",
    });
    fake.say("first answer");
    fake.finish();
    await tick();

    const view = await service.sendPrompt(OWNER, taskId, "two");
    expect(view.status).toBe("running");
    expect(view.turn).toMatchObject({ index: 1, prompt: "two" });
    expect(view.turn.reply).toBe("");
    expect(fake.prompts.map((p) => p.text)).toEqual(["two"]);

    fake.say("second answer");
    fake.finish();
    await tick();

    const latest = await service.get(OWNER, taskId);
    expect(latest.turn.reply).toBe("second answer");
    expect(latest.turns.map((t) => t.status)).toEqual([
      "completed",
      "completed",
    ]);
    const first = await service.get(OWNER, taskId, { turn: 0 });
    expect(first.turn.reply).toBe("first answer");
    // The task-level status reflects the latest turn, not the one inspected.
    expect(first.status).toBe("idle");
  });

  test("an unknown turn index is NotFound", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    await expect(
      service.get(OWNER, taskId, { turn: 7 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a failed turn reports the error and the task accepts another prompt", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    fake.prompts.shift()?.reject(new Error("ACP session is no longer live"));
    await tick();

    const view = await service.get(OWNER, taskId);
    expect(view.status).toBe("failed");
    expect(view.turn).toMatchObject({
      status: "failed",
      error: "ACP session is no longer live",
    });

    const retry = await service.sendPrompt(OWNER, taskId, "again");
    expect(retry.status).toBe("running");
  });
});

describe("cancel and close", () => {
  test("cancel ends the turn as cancelled and keeps the task open", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });

    const view = await service.cancel(OWNER, taskId);

    expect(fake.state.cancelled).toBe(1);
    expect(view.status).toBe("cancelled");
    expect(view.turn).toMatchObject({
      status: "cancelled",
      stopReason: "cancelled",
    });
    expect(fake.state.closed).toBe(0);
    // Still usable.
    expect((await service.sendPrompt(OWNER, taskId, "next")).status).toBe(
      "running",
    );
  });

  test("cancel rejects the task's pending permission requests", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    fake.askPermission("perm-1");

    await service.cancel(OWNER, taskId);

    expect(fake.replies).toEqual([{ id: "perm-1", reply: "reject" }]);
  });

  test("cancel with nothing in flight is a conflict", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    fake.finish();
    await tick();
    await expect(service.cancel(OWNER, taskId)).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  test("close cancels a running turn, releases the session and forgets the task", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    expect(fake.listeners.size).toBe(1);

    await service.close(OWNER, taskId);

    expect(fake.state.cancelled).toBe(1);
    expect(fake.state.closed).toBe(1);
    expect(fake.listeners.size).toBe(0);
    await expect(service.get(OWNER, taskId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(service.list(OWNER)).toEqual([]);
  });

  test("closing an idle task does not cancel anything", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    fake.finish();
    await tick();

    await service.close(OWNER, taskId);

    expect(fake.state.cancelled).toBe(0);
    expect(fake.state.closed).toBe(1);
  });
});

describe("ownership and listing", () => {
  test("other users get NotFound for every operation", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });

    const intruder = "user-2";
    await expect(service.get(intruder, taskId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      service.sendPrompt(intruder, taskId, "hi"),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.cancel(intruder, taskId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(service.close(intruder, taskId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      service.replyPermission(intruder, taskId, "p", "once"),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(service.list(intruder)).toEqual([]);
    // The owner's task is untouched.
    expect((await service.get(OWNER, taskId)).status).toBe("running");
  });

  test("list is newest-first, filterable by sandbox, with prompt previews", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const a = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "first   task\nwith whitespace",
    });
    await Bun.sleep(5);
    const b = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x".repeat(500),
    });

    const all = service.list(OWNER);
    expect(all.map((t) => t.taskId)).toEqual([b.taskId, a.taskId]);
    expect(all[1]?.lastPrompt).toBe("first task with whitespace");
    expect(all[0]?.lastPrompt).toHaveLength(120);
    expect(all[0]?.lastPrompt.endsWith("…")).toBe(true);
    expect(service.list(OWNER, "other-sandbox")).toEqual([]);
    expect(service.list(OWNER, SANDBOX)).toHaveLength(2);
  });
});

describe("idle parking", () => {
  test("a stale finished task releases its session but stays", async () => {
    const fake = makeFake();
    const service = makeService(fake, { idleTtlMs: 30, sweepMs: 10 });
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    fake.say("first answer");
    fake.finish();
    await tick();

    await Bun.sleep(120);

    expect(fake.state.closed).toBe(1);
    const view = await service.get(OWNER, taskId);
    expect(view.status).toBe("idle");
    expect(view.turn.reply).toBe("first answer");
  });

  test("a follow-up on a parked task reopens the same agent session", async () => {
    const fake = makeFake();
    const service = makeService(fake, { idleTtlMs: 30, sweepMs: 10 });
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    fake.finish();
    await tick();
    await Bun.sleep(120);

    const view = await service.sendPrompt(OWNER, taskId, "and now?");

    expect(view.status).toBe("running");
    expect(fake.opened.at(-1)).toMatchObject({
      resumeSessionId: SESSION,
      harnessId: "opencode",
    });
    fake.say("still with you");
    fake.finish();
    await tick();
    const after = await service.get(OWNER, taskId);
    expect(after.sessionId).toBe(SESSION);
    expect(after.turn.reply).toBe("still with you");
    expect(after.turns).toHaveLength(2);
  });

  test("a follow-up after the connection dropped reopens the session", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    fake.finish();
    await tick();
    // The sandbox was paused and resumed: the old socket is gone.
    fake.dropConnection();

    await service.sendPrompt(OWNER, taskId, "again");

    expect(fake.opened.map((o) => o.resumeSessionId)).toEqual([
      undefined,
      SESSION,
    ]);
    expect(fake.prompts.at(-1)?.text).toBe("again");
  });

  test("a follow-up on a paused sandbox asks for a resume and keeps the task", async () => {
    const fake = makeFake();
    const service = makeService(fake);
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    fake.finish();
    await tick();
    fake.dropConnection();
    fake.state.status = "paused";

    await expect(service.sendPrompt(OWNER, taskId, "again")).rejects.toThrow(
      /paused; resume it/,
    );

    fake.state.status = "running";
    const view = await service.sendPrompt(OWNER, taskId, "again");
    expect(view.status).toBe("running");
  });

  test("a parked task is forgotten after the retention window", async () => {
    const fake = makeFake();
    const service = makeService(fake, {
      idleTtlMs: 20,
      retainMs: 40,
      sweepMs: 10,
    });
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    fake.finish();
    await tick();

    await Bun.sleep(150);

    expect(fake.listeners.size).toBe(0);
    await expect(service.get(OWNER, taskId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  test("the per-owner cap forgets parked tasks before refusing", async () => {
    const fake = makeFake();
    const service = makeService(fake, {
      maxTasksPerOwner: 1,
      idleTtlMs: 20,
      sweepMs: 10,
    });
    const first = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    fake.finish();
    await tick();
    await Bun.sleep(80);

    await service.dispatchTask(OWNER, { sandboxId: SANDBOX, prompt: "y" });

    await expect(service.get(OWNER, first.taskId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  test("a turn still in flight is never evicted", async () => {
    const fake = makeFake();
    const service = makeService(fake, { idleTtlMs: 20, sweepMs: 10 });
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });

    await Bun.sleep(100);

    expect(fake.state.closed).toBe(0);
    expect((await service.get(OWNER, taskId)).status).toBe("running");
  });

  test("polling keeps a task alive", async () => {
    const fake = makeFake();
    const service = makeService(fake, { idleTtlMs: 60, sweepMs: 10 });
    const { taskId } = await service.dispatchTask(OWNER, {
      sandboxId: SANDBOX,
      prompt: "x",
    });
    fake.finish();
    await tick();

    for (let i = 0; i < 6; i++) {
      await Bun.sleep(25);
      await service.get(OWNER, taskId);
    }

    expect(fake.state.closed).toBe(0);
  });
});
