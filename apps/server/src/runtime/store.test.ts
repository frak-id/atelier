/**
 * The `Drizzle*` stores over an in-memory SQLite with the real migrations —
 * the same stores production runs.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import * as stores from "./store.ts";
import { useTestDatabase } from "./test-database.ts";

beforeEach(() => useTestDatabase());

const now = () => new Date().toISOString();

describe("DrizzleSnapshotStore", () => {
  const record = (ref: string, hash = `h-${ref}`): stores.SnapshotRecord => ({
    ref,
    hash,
    kind: "prebuild",
    image: "registry.test/base:1",
    createdAt: now(),
  });

  test("round-trips kind, repo heads and the owner", () => {
    const store = new stores.DrizzleSnapshotStore();
    store.put({
      ...record("snap-a"),
      repoHeads: { app: "a".repeat(40) },
      spec: { source: { image: "registry.test/base:1" } },
    });
    store.put({ ...record("snap-b"), kind: "pause", sandboxId: "sb1" });
    expect(store.get("snap-a")).toMatchObject({
      kind: "prebuild",
      repoHeads: { app: "a".repeat(40) },
    });
    expect(store.get("snap-b")).toMatchObject({
      kind: "pause",
      sandboxId: "sb1",
    });
    expect(store.getByHash("h-snap-b")?.ref).toBe("snap-b");
  });

  test("put upserts by ref; a hash under another ref is refused", () => {
    const store = new stores.DrizzleSnapshotStore();
    store.put(record("snap-a"));
    store.put({ ...record("snap-a"), parent: "snap-root" });
    expect(store.list()).toHaveLength(1);
    expect(store.get("snap-a")?.parent).toBe("snap-root");
    // The unique hash index the in-memory fake used to ignore.
    expect(() => store.put(record("snap-other", "h-snap-a"))).toThrow();
  });

  test("deleteBySandbox drops only that owner's rows", () => {
    const store = new stores.DrizzleSnapshotStore();
    store.put({ ...record("snap-a"), kind: "manual", sandboxId: "sb1" });
    store.put({ ...record("snap-b"), kind: "manual", sandboxId: "sb2" });
    store.put(record("snap-c"));
    store.deleteBySandbox("sb1");
    expect(
      store
        .list()
        .map((s) => s.ref)
        .sort(),
    ).toEqual(["snap-b", "snap-c"]);
  });
});

describe("DrizzleSandboxStore", () => {
  test("round-trips the boot image and updates in place", () => {
    const store = new stores.DrizzleSandboxStore();
    store.create({
      id: "sb1",
      spec: {
        source: { image: "registry.test/base:1" },
        resources: { vcpus: 1, memoryMb: 512 },
      },
      status: "creating",
      generated: {},
      metadata: {},
      createdAt: now(),
      updatedAt: now(),
    });
    expect(store.get("sb1")?.image).toBeUndefined();
    store.update("sb1", { image: "registry.test/base@sha256:abc" });
    store.update("sb1", { status: "running", pauseSnapshotRef: "snap-a" });
    expect(store.get("sb1")).toMatchObject({
      image: "registry.test/base@sha256:abc",
      status: "running",
      pauseSnapshotRef: "snap-a",
    });
    store.update("sb1", { pauseSnapshotRef: undefined });
    expect(store.get("sb1")?.pauseSnapshotRef).toBeUndefined();
    expect(store.update("nope", { status: "error" })).toBeUndefined();
  });
});

describe("DrizzleToolsetStore + mount refs", () => {
  test("toolsets round-trip without an env column", () => {
    const store = new stores.DrizzleToolsetStore();
    store.put({
      hash: "h1",
      name: "pi",
      ref: "toolsets/pi@sha256:aa",
      paths: ["~/.pi"],
      provenance: { kind: "captured", capturedFrom: "sb1" },
      private: true,
      createdAt: now(),
    });
    expect(store.getByRef("toolsets/pi@sha256:aa")).toMatchObject({
      name: "pi",
      private: true,
    });
    store.delete("h1");
    expect(store.list()).toEqual([]);
  });

  test("mount refs are replaced per sandbox and aggregated", () => {
    const refs = new stores.DrizzleSandboxToolsetRefStore();
    refs.putForSandbox("a", [{ ref: "t1" }, { ref: "t2" }]);
    refs.putForSandbox("b", [{ ref: "t2" }]);
    refs.putForSandbox("a", [{ ref: "t3" }]);
    expect(refs.referencedRefs()).toEqual(new Set(["t2", "t3"]));
    refs.deleteBySandbox("b");
    expect(refs.referencedRefs()).toEqual(new Set(["t3"]));
  });
});

describe("DrizzleJobStore", () => {
  test("failActive settles only the non-terminal rows", () => {
    const store = new stores.DrizzleJobStore();
    const job = (id: string, status: stores.JobStatus): stores.JobRecord => ({
      id,
      kind: "prebuild",
      status,
      createdAt: now(),
      updatedAt: now(),
    });
    store.create(job("a", "running"));
    store.create(job("b", "queued"));
    store.create(job("c", "succeeded"));
    expect(store.failActive("rebooted").sort()).toEqual(["a", "b"]);
    expect(store.get("a")?.status).toBe("failed");
    expect(store.get("c")?.status).toBe("succeeded");
  });
});
