import { describe, expect, test } from "bun:test";
import {
  attentionCount,
  finishedSince,
  groupTasks,
  markSeen,
  pruneSeen,
} from "./task-inbox.ts";

const task = (
  taskId: string,
  status: string,
  updatedAt = "2026-11-05T10:00:00Z",
) => ({
  taskId,
  status,
  updatedAt,
});

describe("groupTasks", () => {
  test("splits unseen tasks by status, running regardless of seen", () => {
    const groups = groupTasks(
      [
        task("a", "idle"),
        task("b", "running"),
        task("c", "failed"),
        task("d", "cancelled"),
      ],
      { b: "2026-11-05T10:00:00Z" },
    );
    expect(groups.review.map((t) => t.taskId)).toEqual(["a"]);
    expect(groups.running.map((t) => t.taskId)).toEqual(["b"]);
    expect(groups.failed.map((t) => t.taskId)).toEqual(["c"]);
    expect(groups.seen.map((t) => t.taskId)).toEqual(["d"]);
  });

  test("a seen task moves to Seen until it updates again", () => {
    const seen = { a: "2026-11-05T10:00:00Z" };
    expect(groupTasks([task("a", "idle")], seen).seen).toHaveLength(1);
    const later = task("a", "idle", "2026-11-05T11:00:00Z");
    expect(groupTasks([later], seen).review).toHaveLength(1);
  });
});

describe("attentionCount", () => {
  test("counts unseen idle and failed tasks only", () => {
    const tasks = [
      task("a", "idle"),
      task("b", "failed"),
      task("c", "running"),
      task("d", "idle"),
      task("e", "cancelled"),
    ];
    expect(attentionCount(tasks, { d: "2026-11-05T10:00:00Z" })).toBe(2);
  });
});

describe("markSeen / pruneSeen", () => {
  test("records updatedAt and returns the same map when unchanged", () => {
    const tasks = [task("a", "idle")];
    const seen = markSeen({}, tasks);
    expect(seen).toEqual({ a: "2026-11-05T10:00:00Z" });
    expect(markSeen(seen, tasks)).toBe(seen);
  });

  test("drops ids of tasks that are gone", () => {
    const seen = { a: "x", b: "y" };
    expect(pruneSeen(seen, [task("a", "idle")])).toEqual({ a: "x" });
    expect(pruneSeen({ a: "x" }, [task("a", "idle")])).toEqual({ a: "x" });
  });
});

describe("finishedSince", () => {
  test("reports running -> idle/failed, ignoring new and unchanged tasks", () => {
    const previous = [
      task("a", "running"),
      task("b", "running"),
      task("c", "idle"),
      task("d", "running"),
    ];
    const next = [
      task("a", "idle"),
      task("b", "failed"),
      task("c", "idle"),
      task("d", "running"),
      task("e", "idle"),
      task("f", "cancelled"),
    ];
    expect(finishedSince(previous, next).map((t) => t.taskId)).toEqual([
      "a",
      "b",
    ]);
  });
});
