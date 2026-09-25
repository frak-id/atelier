/**
 * Lifecycle contract tests for `RuntimeService` in mock mode (agent/kube
 * calls no-op): status guards, pause→resume snapshot bookkeeping, the
 * per-sandbox op lock, and destroy's snapshot-row GC. These pin the L1-L5
 * audit fixes so a regression fails loudly.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { SandboxSpec } from "@atelier/spec";
import { ConflictError, NotFoundError } from "../shared/errors.ts";

// Config is read once at module load — force mock mode (agent/kube no-op)
// before importing anything that transitively loads it.
process.env.ATELIER_SERVER_MODE = "mock";

let RuntimeService: typeof import("./runtime.service.ts").RuntimeService;
let stores: typeof import("./store.ts");
let KubernetesBackend: typeof import("./backend/index.ts").KubernetesBackend;

beforeAll(async () => {
  ({ RuntimeService } = await import("./runtime.service.ts"));
  stores = await import("./store.ts");
  ({ KubernetesBackend } = await import("./backend/index.ts"));
});

const spec: SandboxSpec = {
  source: { image: "registry.test/base:1" },
  resources: { vcpus: 1, memoryMb: 512 },
};

function makeRuntime() {
  const sandboxes = new stores.InMemorySandboxStore();
  const snapshots = new stores.InMemorySnapshotStore();
  const toolsets = new stores.InMemoryToolsetStore();
  const sandboxToolsetRefs = new stores.InMemorySandboxToolsetRefStore();
  const runtime = new RuntimeService({
    sandboxes,
    snapshots,
    toolsets,
    sandboxToolsetRefs,
  });
  return { runtime, sandboxes, snapshots, toolsets, sandboxToolsetRefs };
}

const TOOLSET_REF = `toolsets/alice-pi-stack@sha256:${"a".repeat(64)}`;

function specWithToolset(): SandboxSpec {
  return { ...spec, toolsets: [{ ref: TOOLSET_REF }] };
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

  // ── toolset mount bookkeeping (toolset-overlay-squashfs.md §6-7) ────────

  // `getForSandbox` was removed as dead code (H4) — these assert through
  // `referencedRefs()`, the one accessor an actual caller (the `deleteToolset`
  // GC guard) uses. Each test uses a single sandbox, so `referencedRefs()`'s
  // aggregate view is equivalent to a per-sandbox lookup here.

  test("create persists the sandbox's mounted toolset refs", async () => {
    const { runtime, sandboxToolsetRefs } = makeRuntime();
    await runtime.create(specWithToolset(), { id: "sb1" });
    expect(sandboxToolsetRefs.referencedRefs()).toEqual(new Set([TOOLSET_REF]));
  });

  test("resume re-persists the mounted toolset refs (survives pause)", async () => {
    const { runtime, sandboxToolsetRefs } = makeRuntime();
    await runtime.create(specWithToolset(), { id: "sb1" });
    await runtime.pause("sb1");
    // Still tracked while paused — a paused sandbox's mount must keep
    // blocking the GC guard, not just a running one.
    expect(sandboxToolsetRefs.referencedRefs()).toEqual(new Set([TOOLSET_REF]));

    await runtime.resume("sb1");
    expect(sandboxToolsetRefs.referencedRefs()).toEqual(new Set([TOOLSET_REF]));
  });

  test("destroy clears the sandbox's mounted toolset refs", async () => {
    const { runtime, sandboxToolsetRefs } = makeRuntime();
    await runtime.create(specWithToolset(), { id: "sb1" });
    await runtime.destroy("sb1");
    expect(sandboxToolsetRefs.referencedRefs()).toEqual(new Set());
  });

  test("deleteToolset refuses a ref mounted by a live sandbox", async () => {
    const { runtime, toolsets } = makeRuntime();
    await runtime.create(specWithToolset(), { id: "sb1" });
    toolsets.put({
      hash: "h1",
      name: "alice-pi-stack",
      ref: TOOLSET_REF,
      paths: ["~/.config/pi"],
      provenance: { kind: "built", build: [] },
      private: false,
      createdAt: new Date().toISOString(),
    });
    expect(() => runtime.deleteToolset(TOOLSET_REF)).toThrow(ConflictError);
  });

  test("deleteToolset refuses a ref mounted by a paused sandbox", async () => {
    const { runtime, toolsets } = makeRuntime();
    await runtime.create(specWithToolset(), { id: "sb1" });
    await runtime.pause("sb1");
    toolsets.put({
      hash: "h1",
      name: "alice-pi-stack",
      ref: TOOLSET_REF,
      paths: ["~/.config/pi"],
      provenance: { kind: "built", build: [] },
      private: false,
      createdAt: new Date().toISOString(),
    });
    expect(() => runtime.deleteToolset(TOOLSET_REF)).toThrow(ConflictError);
  });

  test("deleteToolset succeeds once no sandbox references the ref", async () => {
    const { runtime, toolsets } = makeRuntime();
    await runtime.create(specWithToolset(), { id: "sb1" });
    toolsets.put({
      hash: "h1",
      name: "alice-pi-stack",
      ref: TOOLSET_REF,
      paths: ["~/.config/pi"],
      provenance: { kind: "built", build: [] },
      private: false,
      createdAt: new Date().toISOString(),
    });
    await runtime.destroy("sb1");
    runtime.deleteToolset(TOOLSET_REF);
    expect(() => runtime.deleteToolset(TOOLSET_REF)).toThrow(NotFoundError);
  });

  test("deleteToolset still 404s on an unknown ref", () => {
    const { runtime } = makeRuntime();
    expect(() => runtime.deleteToolset(TOOLSET_REF)).toThrow(NotFoundError);
  });

  test("resume refuses a legacy Filesystem-mode volume with a clear error", async () => {
    // A pre-cutover PVC is Filesystem-mode and immutable; reusing it through
    // the new block-device pod spec would fail k8s admission opaquely and
    // strand the sandbox. The guard turns that into an actionable error.
    const backend = new KubernetesBackend();
    const sandboxes = new stores.InMemorySandboxStore();
    const runtime = new RuntimeService({
      backend,
      sandboxes,
      snapshots: new stores.InMemorySnapshotStore(),
      toolsets: new stores.InMemoryToolsetStore(),
      sandboxToolsetRefs: new stores.InMemorySandboxToolsetRefStore(),
    });
    await runtime.create(spec, { id: "sb1" });
    await runtime.pause("sb1");
    // Simulate the pre-migration disk: it exists, in the old Filesystem mode.
    backend.volumes.volumeExists = async () => true;
    backend.volumes.volumeMode = async () => "Filesystem";
    await expect(runtime.resume("sb1")).rejects.toThrow(/Filesystem-mode/);
    // Left recoverable, not half-torn-down.
    expect(sandboxes.get("sb1")?.status).toBe("paused");
  });

  test("resume proceeds when the reused volume is already Block mode", async () => {
    const backend = new KubernetesBackend();
    const sandboxes = new stores.InMemorySandboxStore();
    const runtime = new RuntimeService({
      backend,
      sandboxes,
      snapshots: new stores.InMemorySnapshotStore(),
      toolsets: new stores.InMemoryToolsetStore(),
      sandboxToolsetRefs: new stores.InMemorySandboxToolsetRefStore(),
    });
    await runtime.create(spec, { id: "sb1" });
    await runtime.pause("sb1");
    backend.volumes.volumeExists = async () => true;
    backend.volumes.volumeMode = async () => "Block";
    await runtime.resume("sb1");
    expect(sandboxes.get("sb1")?.status).toBe("running");
  });
});

describe("prebuild processes/ports", () => {
  const baked = {
    source: { image: "registry.test/base:1" },
    repos: [{ url: "https://github.com/acme/mono", clonePath: "mono" }],
    build: ["cd mono && bun install"],
  };
  // A monorepo: two dev servers, the toolbox scheme.
  const surface = {
    processes: [
      {
        name: "web",
        command: "bun run dev",
        cwd: "/home/dev/mono/apps/web",
        lazy: true,
      },
      {
        name: "api",
        command: "bun run dev",
        cwd: "/home/dev/mono/apps/api",
        lazy: true,
      },
    ],
    ports: [
      { name: "web", port: 5173, public: true },
      { name: "api", port: 3000, public: true },
    ],
  };

  test("never enter the snapshot key; an explicit create saves them", async () => {
    const { runtime } = makeRuntime();
    const first = await runtime.prebuild(baked);
    // Same snapshot: adding (or editing) processes/ports doesn't re-bake…
    const second = await runtime.prebuild(
      { ...baked, ...surface },
      { saveSurface: true },
    );
    expect(second).toEqual(first);
    // …but the stored recipe, applied at boot, now carries them.
    const stored = runtime.prebuildSpec(first.ref);
    expect(stored?.processes).toEqual(surface.processes);
    expect(stored?.ports).toEqual(surface.ports);
    expect(stored?.build).toEqual(baked.build);
    expect(runtime.listPrebuilds()).toHaveLength(1);
  });

  test("a spawn re-resolving a copied recipe never clears them", async () => {
    const { runtime } = makeRuntime();
    const { ref } = await runtime.prebuild(baked);
    runtime.setPrebuildSurface(ref, surface);
    // A Launchpad starter following the prebuild carries the pre-edit copy.
    await runtime.prebuild(baked);
    await runtime.prebuild({ ...baked, ...surface, ports: [] });
    expect(runtime.prebuildSpec(ref)?.processes).toEqual(surface.processes);
    expect(runtime.prebuildSurface(ref)).toEqual(surface);
  });

  test("setPrebuildSurface saves and clears, without a bake", async () => {
    const { runtime } = makeRuntime();
    const { ref } = await runtime.prebuild(baked);
    const saved = runtime.setPrebuildSurface(ref, surface);
    expect(saved.ports).toEqual(surface.ports);
    runtime.setPrebuildSurface(ref, { processes: [], ports: [] });
    expect(runtime.prebuildSpec(ref)).toEqual(baked);
    expect(runtime.listPrebuilds()).toHaveLength(1);
    expect(() => runtime.setPrebuildSurface("snap-nope", surface)).toThrow();
  });

  test("a forced re-bake from a copy inherits them", async () => {
    const { runtime } = makeRuntime();
    const old = await runtime.prebuild(baked);
    runtime.setPrebuildSurface(old.ref, surface);
    // Forced re-bake from a surface-less copy (the quick-prebuild dialog).
    await runtime.prebuild(baked, { force: true });
    expect(runtime.prebuildSpec(old.ref)?.processes).toEqual(surface.processes);
  });

  test("a save reaches every snapshot of the recipe", async () => {
    const { runtime, snapshots } = makeRuntime();
    const old = await runtime.prebuild(baked);
    // The same recipe re-baked after a push: another hash, another ref.
    snapshots.put({
      hash: "h-newer",
      ref: "snap-newer",
      image: "registry.test/base:1",
      spec: { ...baked, metadata: { repo: "acme/mono" } },
      createdAt: new Date(Date.now() + 1000).toISOString(),
    });
    runtime.setPrebuildSurface(old.ref, surface);
    expect(runtime.prebuildSpec("snap-newer")?.ports).toEqual(surface.ports);
    expect(runtime.prebuildSurface("snap-newer")).toEqual(surface);
  });

  test("a different recipe keeps its own", async () => {
    const { runtime } = makeRuntime();
    const a = await runtime.prebuild(baked);
    runtime.setPrebuildSurface(a.ref, surface);
    const b = await runtime.prebuild({ ...baked, build: ["true"] });
    expect(runtime.prebuildSurface(b.ref)).toEqual({});
  });

  test("prebuildSpec is undefined for a pause snapshot", async () => {
    const { runtime } = makeRuntime();
    await runtime.create(spec, { id: "sb1" });
    const snap = await runtime.pause("sb1");
    expect(runtime.prebuildSpec(snap.ref)).toBeUndefined();
  });
});
