import { describe, expect, test } from "bun:test";
import { deadlineIn, redact, sandboxes } from "./sandbox.ts";

/** Atelier's task calls, answering `get_task` from `turns` in order (the last
 * one again past the end); every call recorded. */
function fakeAtelier(
  turns: { status: string; turn: Record<string, unknown> }[],
) {
  const calls: [string, Record<string, unknown>][] = [];
  let polls = 0;
  return {
    calls,
    async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
      calls.push([tool, args]);
      if (tool === "send_prompt")
        return { taskId: "t1", status: "running", turn: {} } as T;
      if (tool === "get_task") {
        const answer = turns[Math.min(polls, turns.length - 1)];
        polls += 1;
        return { taskId: "t1", ...answer } as T;
      }
      return {} as T;
    },
  };
}
const quiet = { log: () => {}, warn: () => {} };
const target = { sandboxId: "s1", cwd: "/home/dev/r" };

describe("an agent's turn", () => {
  test("that shows no tool call and no reply in time is cancelled, its agent taken for dead", async () => {
    const atelier = fakeAtelier([{ status: "running", turn: {} }]);
    const { runTurn } = sandboxes(atelier, quiet, "", {
      startTimeoutMs: 0,
      pollSeconds: 0,
    });
    await expect(
      runTurn(target, "review", deadlineIn(40), "improvements agent"),
    ).rejects.toThrow("the improvements agent never started");
    expect(atelier.calls.at(-1)).toEqual([
      "manage_task",
      { taskId: "t1", action: "cancel" },
    ]);
  });

  test("that started runs on past that, until it ends", async () => {
    const atelier = fakeAtelier([
      {
        status: "running",
        turn: { toolCalls: [{ title: "ls", status: "completed" }] },
      },
      { status: "running", turn: { toolCalls: [] } },
      { status: "idle", turn: { reply: "done" } },
    ]);
    const { runTurn } = sandboxes(atelier, quiet, "", {
      startTimeoutMs: 0,
      pollSeconds: 0,
    });
    const task = await runTurn(target, "review", deadlineIn(40));
    expect(task.turn.reply).toBe("done");
    expect(atelier.calls.map(([tool]) => tool)).not.toContain("manage_task");
  });
});

describe("an exec error", () => {
  test("loses the credentials git or gh could print", () => {
    expect(
      redact(
        "fatal: unable to access 'https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git/'",
      ),
    ).toBe("fatal: unable to access 'https://***@github.com/o/r.git/'");
    expect(redact(`token ${"github_pat_"}${"A1_".repeat(10)} refused`)).toBe(
      "token *** refused",
    );
    expect(redact("gh: HTTP 404 (https://api.github.com/repos/o/r)")).toBe(
      "gh: HTTP 404 (https://api.github.com/repos/o/r)",
    );
  });
});
