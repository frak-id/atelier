/**
 * Lifecycle contract tests for `RuntimeService` in mock mode (agent/kube
 * calls no-op): status guards, pause→resume snapshot bookkeeping, the
 * per-sandbox op lock, and destroy's snapshot-row GC. These pin the L1-L5
 * audit fixes so a regression fails loudly.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { SandboxSpec } from "@atelier/spec";
import { ConflictError } from "../shared/errors.ts";

// Config is read once at module load — force mock mode (agent/kube no-op)
// before importing anything that transitively loads it.
process.env.ATELIER_SERVER_MODE = "mock";

let RuntimeService: typeof import("./runtime.service.ts").RuntimeService;
let stores: typeof import("./store.ts");

beforeAll(async () => {
  ({ RuntimeService } = await import("./runtime.service.ts"));
  stores = await import("./store.ts");
});

const spec: SandboxSpec = {
  source: { image: "registry.test/base:1" },
  resources: { vcpus: 1, memoryMb: 512 },
};

function makeRuntime() {
  const sandboxes = new stores.InMemorySandboxStore();
  const snapshots = new stores.InMemorySnapshotStore();
  const runtime = new RuntimeService({
    sandboxes,
    snapshots,
    toolsets: new stores.InMemoryToolsetStore(),
  });
  return { runtime, sandboxes, snapshots };
}

describe("RuntimeService lifecycle", () => {
  test("create rejects a duplicate id", async () => {
    const { runtime } = makeRuntime();
    await runtime.create(spec, { id: "sb1" });
    expect(runtime.create(spec, { id: "sb1" })).rejects.toThrow(ConflictError);
  });

  test("pause requires running; resume requires paused or error", async () => {
    const { runtime, sandboxes } = makeRuntime();
    await runtime.create(spec, { id: "sb1" });

    await runtime.pause("sb1");
    expect(runtime.pause("sb1")).rejects.toThrow(ConflictError); // paused
    await runtime.resume("sb1");
    expect(runtime.resume("sb1")).rejects.toThrow(ConflictError); // running

    sandboxes.update("sb1", { status: "error" });
    await runtime.resume("sb1"); // error is resumable (recovery route)
    expect(sandboxes.get("sb1")?.status).toBe("running");
  });

  test("pause persists the snapshot ref; resume clears it", async () => {
    const { runtime, sandboxes } = makeRuntime();
    await runtime.create(spec, { id: "sb1" });

    const snap = await runtime.pause("sb1");
    const paused = sandboxes.get("sb1");
    expect(paused?.status).toBe("paused");
    expect(paused?.pauseSnapshotRef).toBe(snap.ref);

    await runtime.resume("sb1");
    const resumed = sandboxes.get("sb1");
    expect(resumed?.status).toBe("running");
    expect(resumed?.pauseSnapshotRef).toBeUndefined();
  });

  test("destroy drops the pause snapshot's store row", async () => {
    const { runtime, snapshots } = makeRuntime();
    await runtime.create(spec, { id: "sb1" });
    const snap = await runtime.pause("sb1");
    expect(snapshots.get(snap.ref)).toBeDefined();

    await runtime.destroy("sb1");
    expect(snapshots.get(snap.ref)).toBeUndefined();
    expect(runtime.list()).toHaveLength(0);
  });

  test("concurrent duplicate ops serialize: second resume fails the guard", async () => {
    const { runtime, sandboxes } = makeRuntime();
    await runtime.create(spec, { id: "sb1" });
    await runtime.pause("sb1");

    const results = await Promise.allSettled([
      runtime.resume("sb1"),
      runtime.resume("sb1"),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(["fulfilled", "rejected"]);
    expect(sandboxes.get("sb1")?.status).toBe("running");
  });

  test("a failed op does not poison the lock queue", async () => {
    const { runtime } = makeRuntime();
    await runtime.create(spec, { id: "sb1" });
    // Fails the status guard (running, not paused)…
    await expect(runtime.resume("sb1")).rejects.toThrow(ConflictError);
    // …and the next op on the same id still runs.
    await runtime.pause("sb1");
    await runtime.destroy("sb1");
  });

  test("snapshot requires a disk (running or paused)", async () => {
    const { runtime, sandboxes } = makeRuntime();
    await runtime.create(spec, { id: "sb1" });
    sandboxes.update("sb1", { status: "error" });
    expect(runtime.snapshot("sb1")).rejects.toThrow(ConflictError);
  });
});
