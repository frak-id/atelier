/**
 * Runtime correctness on real SQLite stores: pause-snapshot GC, a destroyed
 * snapshot owner, the image fixed at create, live mutations under the op
 * lock, prebuild cache safety and the last-good fallback, manual snapshot
 * retention, and what `get` reports about the snapshot a sandbox booted from.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { PrebuildSpec, SandboxSpec } from "@atelier/spec";
import { ConflictError, ValidationError } from "../shared/errors.ts";
import { RuntimeService } from "./runtime.service.ts";
import { FakeBackend, fakeRuntimeDeps } from "./runtime.test-support.ts";
import * as stores from "./store.ts";
import { useTestDatabase } from "./test-database.ts";

beforeEach(() => useTestDatabase());

const spec: SandboxSpec = {
  source: { image: "registry.test/base:1" },
  resources: { vcpus: 1, memoryMb: 512 },
};

function makeRuntime(
  overrides: Partial<ConstructorParameters<typeof RuntimeService>[0]> = {},
) {
  const backend = new FakeBackend();
  const calls = { deleted: [] as string[], reowned: [] as string[][] };
  backend.volumes.deleteSnapshot = async (ref) => {
    calls.deleted.push(ref);
  };
  backend.volumes.reownSnapshot = async (ref, owner) => {
    calls.reowned.push([ref, owner]);
  };
  const sandboxes = new stores.DrizzleSandboxStore();
  const snapshots = new stores.DrizzleSnapshotStore();
  const runtime = new RuntimeService({
    ...fakeRuntimeDeps(),
    backend,
    sandboxes,
    snapshots,
    toolsets: new stores.DrizzleToolsetStore(),
    sandboxToolsetRefs: new stores.DrizzleSandboxToolsetRefStore(),
    ...overrides,
  });
  return { runtime, backend, sandboxes, snapshots, calls };
}

describe("pause snapshot GC", () => {
  test("a successful resume deletes the pause snapshot (volume and row)", async () => {
    const { runtime, snapshots, calls } = makeRuntime();
    await runtime.create(spec, { id: "sb1" });
    const first = await runtime.pause("sb1");
    expect(snapshots.get(first.ref)?.kind).toBe("pause");

    await runtime.resume("sb1");
    expect(calls.deleted).toEqual([first.ref]);
    expect(snapshots.get(first.ref)).toBeUndefined();

    // Every cycle leaves nothing behind.
    const second = await runtime.pause("sb1");
    await runtime.resume("sb1");
    expect(calls.deleted).toEqual([first.ref, second.ref]);
    expect(snapshots.list()).toHaveLength(0);
  });

  test("a failed resume keeps the pause snapshot", async () => {
    const { runtime, backend, snapshots, calls } = makeRuntime();
    await runtime.create(spec, { id: "sb1" });
    const snap = await runtime.pause("sb1");
    backend.boot = async () => {
      throw new Error("no capacity");
    };
    await expect(runtime.resume("sb1")).rejects.toThrow("no capacity");
    expect(calls.deleted).toEqual([]);
    expect(snapshots.get(snap.ref)).toBeDefined();
  });

  test("destroy still drops the pause snapshot row", async () => {
    const { runtime, snapshots } = makeRuntime();
    await runtime.create(spec, { id: "sb1" });
    await runtime.pause("sb1");
    await runtime.destroy("sb1");
    expect(snapshots.list()).toHaveLength(0);
  });
});

describe("the image fixed at create", () => {
  test("pause and resume survive a deleted source snapshot", async () => {
    const { runtime, snapshots, sandboxes } = makeRuntime();
    await runtime.create(spec, { id: "src" });
    const manual = await runtime.snapshot("src");
    await runtime.create(
      { ...spec, source: { snapshot: manual.ref } },
      { id: "b" },
    );
    expect(sandboxes.get("b")?.image).toBe("registry.test/base:1");

    // The source snapshot is gone (and with it anything to re-resolve).
    snapshots.delete(manual.ref);
    await runtime.pause("b");
    await runtime.resume("b");
    expect(sandboxes.get("b")?.status).toBe("running");
    expect(await runtime.getSandboxImage("b")).toBe("registry.test/base:1");
  });

  test("pause does not need the registry", async () => {
    const { runtime, sandboxes } = makeRuntime();
    // A bare image name would need a registry lookup to resolve; the record
    // carries the image it booted from, so pausing never asks.
    sandboxes.create({
      id: "sb2",
      spec: { ...spec, source: { image: "bare-name" } },
      status: "running",
      image: "registry.test/pinned@sha256:abc",
      generated: {},
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const snap = await runtime.pause("sb2");
    expect(snap.ref).toStartWith("snap-");
  });
});

describe("destroying a sandbox others boot from", () => {
  test("keeps a snapshot another sandbox boots from, re-owned to it", async () => {
    const { runtime, snapshots, calls } = makeRuntime();
    await runtime.create(spec, { id: "a" });
    const manual = await runtime.snapshot("a");
    await runtime.create(
      { ...spec, source: { snapshot: manual.ref } },
      { id: "b" },
    );

    await runtime.destroy("a");
    expect(calls.reowned).toEqual([[manual.ref, "b"]]);
    expect(snapshots.get(manual.ref)?.sandboxId).toBe("b");

    // b can still pause and resume; destroying b finally drops it.
    await runtime.pause("b");
    await runtime.resume("b");
    await runtime.destroy("b");
    expect(snapshots.get(manual.ref)).toBeUndefined();
  });

  test("a snapshot nobody boots from is dropped with its owner", async () => {
    const { runtime, snapshots, calls } = makeRuntime();
    await runtime.create(spec, { id: "a" });
    const manual = await runtime.snapshot("a");
    await runtime.destroy("a");
    expect(calls.reowned).toEqual([]);
    expect(snapshots.get(manual.ref)).toBeUndefined();
  });
});

describe("live mutations", () => {
  test("addPort needs a running sandbox", async () => {
    const { runtime } = makeRuntime();
    await runtime.create(spec, { id: "sb1" });
    await runtime.pause("sb1");
    await expect(
      runtime.addPort("sb1", { name: "web", port: 5173 }),
    ).rejects.toThrow(ConflictError);
  });

  test("addPort records the port only once it is exposed", async () => {
    const { runtime, backend, sandboxes } = makeRuntime();
    await runtime.create(spec, { id: "sb1" });
    backend.exposePort = async () => {
      throw new ValidationError("cannot expose");
    };
    await expect(
      runtime.addPort("sb1", { name: "web", port: 5173 }),
    ).rejects.toThrow("cannot expose");
    expect(sandboxes.get("sb1")?.spec.ports).toBeUndefined();

    backend.exposePort = async () => {};
    await runtime.addPort("sb1", { name: "web", port: 5173 });
    expect(sandboxes.get("sb1")?.spec.ports).toEqual([
      { name: "web", port: 5173, public: true },
    ]);
  });
});

describe("prebuild cache safety", () => {
  const baked: PrebuildSpec = {
    source: { image: "registry.test/base:1" },
    repos: [{ url: "https://github.com/acme/app", clonePath: "app" }],
    build: ["bun install"],
  };

  test("an unresolvable repo HEAD never serves a cache hit", async () => {
    let head: string | null = "a".repeat(40);
    const { runtime } = makeRuntime({ remoteHead: async () => head });
    await runtime.prebuild(baked);
    expect(await runtime.cachedPrebuild(baked)).toBeDefined();

    head = null; // git ls-remote fails
    await expect(runtime.prebuild(baked)).rejects.toThrow(/Cannot resolve/);
    await expect(runtime.prebuild(baked, { force: true })).rejects.toThrow(
      /Cannot resolve/,
    );
    expect(await runtime.cachedPrebuild(baked)).toBeUndefined();
  });

  test("a spawn falls back to the last good prebuild when the fresh one fails", async () => {
    let head = "a".repeat(40);
    const { runtime, backend } = makeRuntime({ remoteHead: async () => head });
    const good = await runtime.prebuild(baked);

    head = "b".repeat(40); // upstream moved; the new bake breaks
    backend.boot = async () => {
      throw new Error("build pod failed");
    };
    const spawned = await runtime.prebuildForSpawn(baked);
    expect(spawned.ref).toBe(good.ref);
    expect(spawned.warning).toContain("build pod failed");
    expect(spawned.warning).toContain("last good");
  });

  test("an unreachable remote also falls back, with a warning", async () => {
    let head: string | null = "a".repeat(40);
    const { runtime } = makeRuntime({ remoteHead: async () => head });
    const good = await runtime.prebuild(baked);
    head = null;
    const spawned = await runtime.prebuildForSpawn(baked);
    expect(spawned.ref).toBe(good.ref);
    expect(spawned.warning).toContain("git HEAD");
  });

  test("no fallback without a previous bake, or when the caller was wrong", async () => {
    const { runtime, backend } = makeRuntime();
    backend.boot = async () => {
      throw new Error("build pod failed");
    };
    await expect(runtime.prebuildForSpawn(baked)).rejects.toThrow(
      "build pod failed",
    );
    await expect(
      runtime.prebuildForSpawn({ ...baked, source: { snapshot: "snap-gone" } }),
    ).rejects.toThrow(/not found/);
  });

  test("a successful fresh build has no warning", async () => {
    const { runtime } = makeRuntime();
    const spawned = await runtime.prebuildForSpawn(baked);
    expect(spawned.warning).toBeUndefined();
  });

  test("prune keeps the newest snapshot of a lineage even at keep 0", async () => {
    let head = "a".repeat(40);
    const { runtime, snapshots } = makeRuntime({
      remoteHead: async () => head,
    });
    const older = await runtime.prebuild(baked);
    await Bun.sleep(2);
    head = "b".repeat(40);
    const newer = await runtime.prebuild(baked);
    expect(snapshots.list()).toHaveLength(2);

    expect(await runtime.pruneUnusedPrebuilds(0)).toBe(1);
    expect(snapshots.get(older.ref)).toBeUndefined();
    expect(snapshots.get(newer.ref)).toBeDefined();
    // Nothing left to prune: the last snapshot of the recipe stays.
    expect(await runtime.pruneUnusedPrebuilds(0)).toBe(0);
  });

  test("a prebuild records the repo HEADs it was baked on", async () => {
    const { runtime, snapshots } = makeRuntime({
      remoteHead: async () => "c".repeat(40),
    });
    const { ref } = await runtime.prebuild(baked);
    expect(snapshots.get(ref)?.repoHeads).toEqual({ app: "c".repeat(40) });
    expect(snapshots.get(ref)?.kind).toBe("prebuild");
  });
});

describe("manual snapshot retention", () => {
  test("keeps the last N per sandbox, never one that is booted from", async () => {
    const { runtime, snapshots, calls } = makeRuntime();
    await runtime.create(spec, { id: "a" });
    const first = await runtime.snapshot("a");
    // A sandbox boots from the oldest one: it must survive the pruning.
    await runtime.create(
      { ...spec, source: { snapshot: first.ref } },
      { id: "b" },
    );
    const refs = [first.ref];
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(2); // distinct creation times: "newest" is well-defined
      refs.push((await runtime.snapshot("a")).ref);
    }

    const kept = snapshots
      .list()
      .filter((s) => s.kind === "manual" && s.sandboxId === "a")
      .map((s) => s.ref);
    // The referenced one plus the newest 5 (the default keep).
    expect(kept).toHaveLength(6);
    expect(kept).toContain(first.ref);
    expect(kept).toContain(refs[6] as string);
    expect(calls.deleted).toHaveLength(1);
  });

  test("another sandbox's snapshots are not counted", async () => {
    const { runtime, snapshots } = makeRuntime();
    await runtime.create(spec, { id: "a" });
    await runtime.create(spec, { id: "b" });
    for (let i = 0; i < 5; i++) await runtime.snapshot("a");
    await runtime.snapshot("b");
    expect(snapshots.list().filter((s) => s.sandboxId === "a")).toHaveLength(5);
  });
});

describe("get().bootedFrom", () => {
  test("names the prebuild a sandbox booted from, with its repo HEADs", async () => {
    const { runtime } = makeRuntime({
      remoteHead: async () => "d".repeat(40),
    });
    const { ref } = await runtime.prebuild({
      source: { image: "registry.test/base:1" },
      repos: [{ url: "https://github.com/acme/app", clonePath: "app" }],
    });
    await runtime.create({ ...spec, source: { snapshot: ref } }, { id: "sb1" });
    const state = await runtime.get("sb1");
    expect(state.bootedFrom).toMatchObject({
      ref,
      kind: "prebuild",
      image: "registry.test/base:1",
      repoHeads: { app: "d".repeat(40) },
    });
    expect(state.bootedFrom?.builtAt).toBeString();
  });

  test("an image-booted sandbox has none", async () => {
    const { runtime } = makeRuntime();
    await runtime.create(spec, { id: "sb1" });
    expect((await runtime.get("sb1")).bootedFrom).toBeUndefined();
  });
});
