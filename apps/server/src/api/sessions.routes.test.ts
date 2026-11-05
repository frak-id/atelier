/**
 * `/sessions/tasks` action routes: the console's task inbox starts, prompts,
 * cancels and closes tasks through them. The task service is faked; what is
 * under test is the access rule, the defaults and the call shapes.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { NotFoundError, SandboxError } from "../shared/errors.ts";
import type { ServerContainer } from "./container.ts";
import { createSessionsRoutes } from "./sessions.routes.ts";

const OWNER = "atelier.dev/owner-id";

const labels: Record<
  string,
  { metadata: Record<string, string>; annotations: Record<string, string> }
> = {
  mine: {
    metadata: { [OWNER]: "alice" },
    annotations: { "atelier.dev/name": "My box" },
  },
  bare: { metadata: { [OWNER]: "alice" }, annotations: {} },
  cloned: { metadata: { [OWNER]: "alice" }, annotations: {} },
  theirs: { metadata: { [OWNER]: "bob" }, annotations: {} },
};

const calls: [string, ...unknown[]][] = [];

const taskDetail = (taskId: string, sandboxId: string) => ({
  taskId,
  sandboxId,
  status: "running",
});

let app: Elysia;

beforeAll(() => {
  const tasks = {
    dispatchTask: async (
      user: string,
      input: { sandboxId: string; cwd?: string; source?: string },
    ) => {
      calls.push(["dispatch", user, input]);
      return { taskId: "tsk_new" };
    },
    describe: (taskId: string) => {
      const sandboxId = { tsk_mine: "mine", tsk_theirs: "theirs" }[taskId];
      if (!sandboxId) throw new NotFoundError("Task", taskId);
      return taskDetail(taskId, sandboxId);
    },
    sendPrompt: async (user: string, taskId: string, text: string) => {
      calls.push(["prompt", user, taskId, text]);
    },
    cancel: async (user: string, taskId: string) => {
      calls.push(["cancel", user, taskId]);
    },
    close: async (user: string, taskId: string) => {
      calls.push(["close", user, taskId]);
    },
  };
  // `tsk_new` resolves once dispatched.
  const describeTask = tasks.describe;
  tasks.describe = (taskId: string) =>
    taskId === "tsk_new" ? taskDetail(taskId, "mine") : describeTask(taskId);

  const container = {
    tasks,
    runtime: {
      getLabels: (id: string) => labels[id],
      list: () => [
        { id: "mine", repos: [{ url: "https://github.com/a/wallet.git" }] },
        { id: "bare" },
        // Booted a bare image and cloned its repo at boot: no prebuild repos.
        {
          id: "cloned",
          annotations: {
            "atelier.dev/checkout": "https://github.com/a/landing#dev",
          },
        },
      ],
    },
    control: {
      authService: {
        resolveToken: async (token?: string) => {
          if (token === "alice") return { id: "alice" };
          throw new NotFoundError("User", "x");
        },
      },
      canAccessSandbox: (
        userId: string,
        l: { metadata: Record<string, string> },
      ) => l.metadata[OWNER] === userId,
    },
  } as unknown as ServerContainer;

  app = new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof SandboxError) {
        set.status = error.statusCode;
        return { error: error.code };
      }
    })
    .use(createSessionsRoutes(container)) as unknown as Elysia;
});

function post(method: string, path: string, body?: unknown) {
  calls.length = 0;
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        authorization: "Bearer alice",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}

describe("POST /sessions/tasks", () => {
  test("starts a console task in the first repo checkout", async () => {
    const res = await post("POST", "/sessions/tasks", {
      sandboxId: "mine",
      prompt: "fix it",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      taskId: "tsk_new",
      sandboxName: "My box",
    });
    expect(calls).toEqual([
      [
        "dispatch",
        "alice",
        {
          sandboxId: "mine",
          prompt: "fix it",
          cwd: "/home/dev/wallet",
          source: "console",
        },
      ],
    ]);
  });

  test("an explicit cwd wins, a repo-less sandbox gets the home", async () => {
    await post("POST", "/sessions/tasks", {
      sandboxId: "mine",
      prompt: "p",
      cwd: "/tmp/x",
    });
    expect(calls[0]?.[2]).toMatchObject({ cwd: "/tmp/x" });
    await post("POST", "/sessions/tasks", { sandboxId: "bare", prompt: "p" });
    expect(calls[0]?.[2]).toMatchObject({ cwd: "/home/dev" });
  });

  test("a repo cloned at boot is the default cwd too", async () => {
    await post("POST", "/sessions/tasks", { sandboxId: "cloned", prompt: "p" });
    expect(calls[0]?.[2]).toMatchObject({ cwd: "/home/dev/landing" });
  });

  test("another user's sandbox is a 404 and dispatches nothing", async () => {
    const res = await post("POST", "/sessions/tasks", {
      sandboxId: "theirs",
      prompt: "p",
    });
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe("task actions", () => {
  test("prompt, cancel and close call the service as the user", async () => {
    const prompt = await post("POST", "/sessions/tasks/tsk_mine/prompt", {
      text: "more",
    });
    expect(prompt.status).toBe(200);
    expect(calls).toEqual([["prompt", "alice", "tsk_mine", "more"]]);

    const cancel = await post("POST", "/sessions/tasks/tsk_mine/cancel");
    expect(cancel.status).toBe(200);
    expect(calls).toEqual([["cancel", "alice", "tsk_mine"]]);

    const close = await post("DELETE", "/sessions/tasks/tsk_mine");
    expect(close.status).toBe(204);
    expect(calls).toEqual([["close", "alice", "tsk_mine"]]);
  });

  test("a task on a foreign sandbox or an unknown task is a 404", async () => {
    for (const [method, path, body] of [
      ["POST", "/sessions/tasks/tsk_theirs/prompt", { text: "x" }],
      ["POST", "/sessions/tasks/tsk_theirs/cancel"],
      ["DELETE", "/sessions/tasks/tsk_theirs"],
      ["DELETE", "/sessions/tasks/tsk_nope"],
    ] as const) {
      const res = await post(method, path, body);
      expect(res.status).toBe(404);
      expect(calls).toEqual([]);
    }
  });
});
