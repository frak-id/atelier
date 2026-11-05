import { beforeEach, describe, expect, test } from "bun:test";
import { useTestDatabase } from "../runtime/test-database.ts";
import { DrizzleTaskStore, type StoredTask } from "./task.store.ts";

const task = (over: Partial<StoredTask> = {}): StoredTask => ({
  id: "tsk_1",
  ownerId: "u1",
  sandboxId: "sbx-1",
  sessionId: "sess-1",
  cwd: "/home/dev",
  harness: "pi",
  status: "idle",
  title: "Fix it",
  source: "mcp",
  turnCount: 1,
  lastPrompt: "Fix it",
  lastReply: "done",
  createdAt: "2026-11-05T10:00:00.000Z",
  updatedAt: "2026-11-05T10:05:00.000Z",
  ...over,
});

describe("DrizzleTaskStore", () => {
  let store: DrizzleTaskStore;
  beforeEach(() => {
    useTestDatabase();
    store = new DrizzleTaskStore();
  });

  test("upsert round-trips and replaces", () => {
    store.upsert(
      task({
        result: { branch: "main", commitsAhead: 0, capturedAt: "t" },
      }),
    );
    store.upsert(task({ status: "failed", lastError: "boom" }));
    expect(store.get("tsk_1")).toMatchObject({
      status: "failed",
      lastError: "boom",
    });
    store.upsert(task({ result: { branch: "main", capturedAt: "t" } }));
    expect(store.get("tsk_1")?.result?.branch).toBe("main");
    expect(store.get("tsk_1")?.lastError).toBeUndefined();
  });

  test("lists newest first with filters", () => {
    store.upsert(task({ id: "a", createdAt: "2026-11-05T09:00:00.000Z" }));
    store.upsert(task({ id: "b", sandboxId: "sbx-2", status: "running" }));
    expect(store.list({}).map((t) => t.id)).toEqual(["b", "a"]);
    expect(store.list({ sandboxIds: ["sbx-1"] }).map((t) => t.id)).toEqual([
      "a",
    ]);
    expect(store.list({ status: "running" }).map((t) => t.id)).toEqual(["b"]);
    expect(store.list({ sandboxIds: [] })).toEqual([]);
    expect(store.list({ limit: 1 })).toHaveLength(1);
  });

  test("fails interrupted turns and prunes stale rows", () => {
    store.upsert(task({ id: "a", status: "running" }));
    store.upsert(task({ id: "b", updatedAt: "2026-10-01T00:00:00.000Z" }));
    store.failInterrupted("restarted");
    expect(store.get("a")).toMatchObject({
      status: "failed",
      lastError: "restarted",
    });
    store.deleteUpdatedBefore("2026-11-01T00:00:00.000Z");
    expect(store.get("b")).toBeUndefined();
    expect(store.get("a")).toBeDefined();
  });
});
