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

  test("resume reuses the live volume when it still exists", async () => {
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

  // A Launchpad starter's stale copy of the dev servers, from before an edit.
  const stale = {
    processes: [{ name: "web", command: "npm start", lazy: true }],
    ports: [{ name: "web", port: 3000, public: true }],
  };

  test("a spawn's bake never overwrites them", async () => {
    const { runtime } = makeRuntime();
    const old = await runtime.prebuild(baked);
    runtime.setPrebuildSurface(old.ref, surface);
    // The repo moved: the spawn re-resolving the starter's recipe bakes.
    const fresh = await runtime.prebuild(
      { ...baked, ...stale },
      { force: true },
    );
    expect(runtime.prebuildSurface(old.ref)).toEqual(surface);
    expect(runtime.prebuildSurface(fresh.ref)).toEqual(surface);
    expect(runtime.prebuildSpec(fresh.ref)?.ports).toEqual(surface.ports);
  });

  test("a recipe's first bake records what it declares", async () => {
    const { runtime } = makeRuntime();
    // A "set it up here" starter's inline recipe, launched for the first time.
    const { ref } = await runtime.prebuild({ ...baked, ...surface });
    expect(runtime.prebuildSurface(ref)).toEqual(surface);
  });

  test("an explicit rebuild saves them, on every snapshot", async () => {
    const { runtime } = makeRuntime();
    const old = await runtime.prebuild({ ...baked, ...surface });
    const fresh = await runtime.prebuild(
      { ...baked, ...stale },
      { force: true, saveSurface: true },
    );
    expect(runtime.prebuildSurface(fresh.ref)).toEqual(stale);
    expect(runtime.prebuildSpec(old.ref)?.ports).toEqual(stale.ports);
  });

  test("a save joining a spawn's in-flight bake still saves", async () => {
    const { runtime } = makeRuntime();
    const old = await runtime.prebuild(baked);
    // Same content, concurrently: the save dedupes onto the spawn's bake.
    const [spawned, saved] = await Promise.all([
      runtime.prebuild({ ...baked, ...stale }, { force: true }),
      runtime.prebuild(
        { ...baked, ...surface },
        { force: true, saveSurface: true },
      ),
    ]);
    expect(saved.ref).toBe(spawned.ref);
    expect(runtime.prebuildSurface(spawned.ref)).toEqual(surface);
    expect(runtime.prebuildSurface(old.ref)).toEqual(surface);
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

describe("prebuild creator", () => {
  const baked = {
    source: { image: "registry.test/base:1" },
    repos: [{ url: "https://github.com/acme/private", clonePath: "app" }],
    build: ["cd app && bun install"],
  };

  test("a bake records who baked it", async () => {
    const { runtime, snapshots } = makeRuntime();
    const { ref } = await runtime.prebuild(baked, {
      githubToken: "tok-alice",
      createdBy: "alice",
    });
    expect(snapshots.get(ref)?.createdBy).toBe("alice");
  });

  test("a cache hit adopts a creator-less prebuild, never replaces one", async () => {
    const { runtime, snapshots } = makeRuntime();
    const { ref } = await runtime.prebuild(baked);
    expect(snapshots.get(ref)?.createdBy).toBeUndefined();
    // No token: nothing proves the caller can read the repos.
    await runtime.prebuild(baked, { createdBy: "bob" });
    expect(snapshots.get(ref)?.createdBy).toBeUndefined();
    await runtime.prebuild(baked, { githubToken: "t", createdBy: "alice" });
    expect(snapshots.get(ref)?.createdBy).toBe("alice");
    await runtime.prebuild(baked, { githubToken: "t", createdBy: "bob" });
    expect(snapshots.get(ref)?.createdBy).toBe("alice");
  });

  test("the staleness refresh re-bakes with the creator's own token", async () => {
    const { runtime, snapshots } = makeRuntime();
    // A prebuild whose key no longer matches: upstream moved.
    snapshots.put({
      hash: "h-stale",
      ref: "snap-stale",
      image: "registry.test/base:1",
      spec: baked,
      createdBy: "alice",
      createdAt: new Date().toISOString(),
    });
    const asked: string[] = [];
    const rebakes: { githubToken?: string; createdBy?: string }[] = [];
    const prebuild = runtime.prebuild.bind(runtime);
    runtime.prebuild = (s, options = {}) => {
      rebakes.push({
        githubToken: options.githubToken,
        createdBy: options.createdBy,
      });
      return prebuild(s, options);
    };

    await runtime.refreshStalePrebuilds((userId) => {
      asked.push(userId);
      return `tok-${userId}`;
    });

    expect(asked).toEqual(["alice"]);
    expect(rebakes).toEqual([{ githubToken: "tok-alice", createdBy: "alice" }]);
    const fresh = runtime.listPrebuilds().find((p) => p.ref !== "snap-stale");
    expect(fresh && snapshots.get(fresh.ref)?.createdBy).toBe("alice");
  });
});

describe("display annotations", () => {
  test("setAnnotation sets and clears one key, keeping the others", async () => {
    const { runtime, sandboxes } = makeRuntime();
    await runtime.create(
      { ...spec, annotations: { "atelier.dev/owner": "alice" } },
      { id: "sb1" },
    );
    runtime.setAnnotation("sb1", "atelier.dev/name", "my box");
    expect(sandboxes.get("sb1")?.spec.annotations).toEqual({
      "atelier.dev/owner": "alice",
      "atelier.dev/name": "my box",
    });
    runtime.setAnnotation("sb1", "atelier.dev/name", undefined);
    expect(sandboxes.get("sb1")?.spec.annotations).toEqual({
      "atelier.dev/owner": "alice",
    });
  });

  test("setAnnotation on an unknown sandbox is a 404", () => {
    const { runtime } = makeRuntime();
    expect(() => runtime.setAnnotation("nope", "k", "v")).toThrow(
      NotFoundError,
    );
  });

  test("a rename made during a resume survives it", async () => {
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
    // Awaited by resume after it has read the record: rename right there.
    backend.volumes.volumeExists = async () => {
      runtime.setAnnotation("sb1", "atelier.dev/name", "renamed");
      return false;
    };
    await runtime.resume("sb1");
    const record = sandboxes.get("sb1");
    expect(record?.status).toBe("running");
    expect(record?.spec.annotations?.["atelier.dev/name"]).toBe("renamed");
  });
});

describe("list() repos", () => {
  const repo = (url: string, branch?: string) => ({
    url,
    ...(branch ? { branch } : {}),
    clonePath: "r",
  });

  function putPrebuild(
    snapshots: InstanceType<typeof stores.InMemorySnapshotStore>,
    ref: string,
    repos: ReturnType<typeof repo>[],
    parent?: string,
  ) {
    snapshots.put({
      hash: `h-${ref}`,
      ref,
      image: "registry.test/base:1",
      parent,
      spec: {
        source: parent
          ? { snapshot: parent }
          : { image: "registry.test/base:1" },
        repos,
      },
      createdAt: new Date().toISOString(),
    });
  }

  test("an image-booted sandbox has no repos", async () => {
    const { runtime } = makeRuntime();
    await runtime.create(spec, { id: "sb1" });
    expect(runtime.list()[0]?.repos).toBeUndefined();
  });

  test("a prebuild-booted sandbox lists its prebuild's repos", async () => {
    const { runtime, snapshots, sandboxes } = makeRuntime();
    putPrebuild(snapshots, "snap-a", [
      repo("https://github.com/acme/site", "dev"),
    ]);
    sandboxes.create({
      id: "sb1",
      spec: { ...spec, source: { snapshot: "snap-a" } },
      status: "running",
      generated: {},
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(runtime.list()[0]?.repos).toEqual([
      { url: "https://github.com/acme/site", branch: "dev" },
    ]);
  });

  test("a chained prebuild inherits its parents' repos, root first", async () => {
    const { runtime, snapshots, sandboxes } = makeRuntime();
    putPrebuild(snapshots, "snap-root", [
      repo("https://github.com/acme/api"),
      repo("https://github.com/acme/web", "main"),
    ]);
    putPrebuild(
      snapshots,
      "snap-child",
      [repo("git@github.com:acme/web.git", "feat")],
      "snap-root",
    );
    sandboxes.create({
      id: "sb1",
      spec: { ...spec, source: { snapshot: "snap-child" } },
      status: "paused",
      generated: {},
      metadata: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // Deduped by repo identity; the nearer bake's branch wins.
    expect(runtime.list()[0]?.repos).toEqual([
      { url: "https://github.com/acme/api" },
      { url: "git@github.com:acme/web.git", branch: "feat" },
    ]);
  });
});

describe("list() metadata filter", () => {
  test("keeps only sandboxes whose metadata holds every pair", async () => {
    const { runtime } = makeRuntime();
    await runtime.create(
      { ...spec, metadata: { steery: "host", "steery-key": "k1" } },
      { id: "sb1" },
    );
    await runtime.create(
      { ...spec, metadata: { steery: "host" } },
      { id: "sb2" },
    );
    await runtime.create(spec, { id: "sb3" });

    const ids = (filter?: Record<string, string>) =>
      runtime
        .list(filter)
        .map((s) => s.id)
        .sort();
    expect(ids()).toEqual(["sb1", "sb2", "sb3"]);
    expect(ids({ steery: "host" })).toEqual(["sb1", "sb2"]);
    expect(ids({ steery: "host", "steery-key": "k1" })).toEqual(["sb1"]);
    expect(ids({ steery: "other" })).toEqual([]);
    expect(runtime.list().find((s) => s.id === "sb3")?.metadata).toEqual({});
  });
});

/** A fork derivation that keeps the source's spec and sets `metadata`. */
function keepSpec(metadata: Record<string, string> = {}) {
  return (source: SandboxSpec) => ({ spec: { ...source, metadata } });
}

/** Fork arguments: a derive step plus the (empty) initial labels. */
function forkWith(
  derive: (source: SandboxSpec) => {
    spec: SandboxSpec;
    authorizedKeys?: string[];
  } = keepSpec(),
) {
  return { derive, initial: { metadata: {}, annotations: {} } };
}

describe("fork()", () => {
  test("boots a copy from a fresh snapshot with the derived spec", async () => {
    const { runtime, sandboxes } = makeRuntime();
    await runtime.create(
      {
        ...specWithToolset(),
        env: { A: "1" },
        metadata: { steery: "host", "steery-key": "k1" },
        annotations: { "atelier.dev/name": "src", keep: "yes" },
      },
      { id: "src" },
    );

    await runtime.fork(
      "src",
      {
        ...forkWith(keepSpec({ steery: "host", "steery-key": "k2" })),
        name: "copy",
      },
      { id: "dst" },
    );

    const copy = sandboxes.get("dst");
    expect(copy?.status).toBe("running");
    expect(copy?.spec.source).toEqual({
      snapshot: expect.stringMatching(/^snap-/),
    });
    expect(copy?.spec.env).toEqual({ A: "1" });
    expect(copy?.spec.toolsets).toEqual([{ ref: TOOLSET_REF }]);
    expect(copy?.metadata).toEqual({ steery: "host", "steery-key": "k2" });
    expect(copy?.spec.annotations).toEqual({
      "atelier.dev/name": "copy",
      keep: "yes",
    });
    expect(sandboxes.get("src")?.status).toBe("running");
  });

  test("an unnamed fork drops the source's name", async () => {
    const { runtime, sandboxes } = makeRuntime();
    await runtime.create(
      { ...spec, annotations: { "atelier.dev/name": "src" } },
      { id: "src" },
    );
    await runtime.fork("src", forkWith(), { id: "dst" });
    expect(sandboxes.get("dst")?.spec.annotations).toEqual({});
  });

  test("derive sees the stored spec and its authorizedKeys reach the boot", async () => {
    const backend = new KubernetesBackend();
    const runtime = new RuntimeService({
      backend,
      sandboxes: new stores.InMemorySandboxStore(),
      snapshots: new stores.InMemorySnapshotStore(),
      toolsets: new stores.InMemoryToolsetStore(),
      sandboxToolsetRefs: new stores.InMemorySandboxToolsetRefStore(),
    });
    await runtime.create({ ...spec, env: { A: "1" } }, { id: "src" });
    const boot = backend.boot.bind(backend);
    let bootKeys: string[] | undefined;
    backend.boot = (id, bootSpec, opts, agent) => {
      bootKeys = opts.authorizedKeys;
      return boot(id, bootSpec, opts, agent);
    };
    let seen: SandboxSpec | undefined;
    await runtime.fork(
      "src",
      {
        ...forkWith((source) => {
          seen = source;
          return { spec: source, authorizedKeys: ["ssh-ed25519 AAAA"] };
        }),
      },
      { id: "dst" },
    );
    expect(seen?.env).toEqual({ A: "1" });
    expect(bootKeys).toEqual(["ssh-ed25519 AAAA"]);
  });

  test("the copy owns its snapshot: row and VolumeSnapshot label are the fork id", async () => {
    const backend = new KubernetesBackend();
    const labels: Record<string, string>[] = [];
    backend.volumes.snapshot = async (_pvc, _ref, l) => {
      labels.push(l);
    };
    const sandboxes = new stores.InMemorySandboxStore();
    const snapshots = new stores.InMemorySnapshotStore();
    const runtime = new RuntimeService({
      backend,
      sandboxes,
      snapshots,
      toolsets: new stores.InMemoryToolsetStore(),
      sandboxToolsetRefs: new stores.InMemorySandboxToolsetRefStore(),
    });
    await runtime.create(spec, { id: "src" });
    await runtime.fork("src", forkWith(), { id: "dst" });

    expect(labels).toEqual([{ "atelier.dev/sandbox": "dst" }]);
    const source = sandboxes.get("dst")?.spec.source;
    const ref = source && "snapshot" in source ? source.snapshot : "";
    expect(snapshots.get(ref)?.sandboxId).toBe("dst");
  });

  test("destroying the source leaves the copy able to pause, snapshot and fork", async () => {
    const { runtime, sandboxes } = makeRuntime();
    await runtime.create(spec, { id: "src" });
    await runtime.fork("src", forkWith(), { id: "dst" });

    await runtime.destroy("src");
    expect(sandboxes.get("dst")?.status).toBe("running");

    await runtime.snapshot("dst");
    await runtime.fork("dst", forkWith(), { id: "dst2" });
    expect(sandboxes.get("dst2")?.status).toBe("running");
    await runtime.pause("dst");
    await runtime.resume("dst");
    expect(sandboxes.get("dst")?.status).toBe("running");
  });

  test("a paused copy resumes from its own snapshot after the source is gone", async () => {
    const { runtime, sandboxes } = makeRuntime();
    await runtime.create(spec, { id: "src" });
    await runtime.fork("src", forkWith(), { id: "dst" });
    await runtime.destroy("src");
    await runtime.pause("dst");
    // Disk gone too: resume must clone from a snapshot that still exists.
    sandboxes.update("dst", { pvcName: undefined });
    await runtime.resume("dst");
    expect(sandboxes.get("dst")?.status).toBe("running");
  });

  test("destroying the copy GCs its snapshot row, not the source's", async () => {
    const { runtime, snapshots } = makeRuntime();
    await runtime.create(spec, { id: "src" });
    const own = await runtime.snapshot("src");
    await runtime.fork("src", forkWith(), { id: "dst" });
    expect(snapshots.list().filter((s) => s.sandboxId === "dst")).toHaveLength(
      1,
    );

    await runtime.destroy("dst");
    expect(snapshots.list().filter((s) => s.sandboxId === "dst")).toHaveLength(
      0,
    );
    expect(snapshots.get(own.ref)).toBeDefined();
  });

  test("the copy is `creating` before the snapshot finishes", async () => {
    const backend = new KubernetesBackend();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    backend.volumes.snapshot = async () => {
      await gate;
    };
    const sandboxes = new stores.InMemorySandboxStore();
    const runtime = new RuntimeService({
      backend,
      sandboxes,
      snapshots: new stores.InMemorySnapshotStore(),
      toolsets: new stores.InMemoryToolsetStore(),
      sandboxToolsetRefs: new stores.InMemorySandboxToolsetRefStore(),
    });
    await runtime.create(spec, { id: "src" });

    const pending = runtime.fork("src", forkWith(), { id: "dst" });
    // Synchronously after the call: the record is already there.
    expect(sandboxes.get("dst")?.status).toBe("creating");
    await new Promise((r) => setTimeout(r, 5));
    expect(sandboxes.get("dst")?.status).toBe("creating");

    release();
    await pending;
    expect(sandboxes.get("dst")?.status).toBe("running");
  });

  test("a failing snapshot ends the copy in `error`; resume says the snapshot is gone", async () => {
    const backend = new KubernetesBackend();
    backend.volumes.snapshot = async () => {
      throw new Error("snapshot boom");
    };
    const sandboxes = new stores.InMemorySandboxStore();
    const snapshots = new stores.InMemorySnapshotStore();
    const runtime = new RuntimeService({
      backend,
      sandboxes,
      snapshots,
      toolsets: new stores.InMemoryToolsetStore(),
      sandboxToolsetRefs: new stores.InMemorySandboxToolsetRefStore(),
    });
    await runtime.create(spec, { id: "src" });
    await expect(
      runtime.fork("src", forkWith(), { id: "dst" }),
    ).rejects.toThrow("snapshot boom");
    expect(sandboxes.get("dst")?.status).toBe("error");
    // Never the source's base image: the record points at its own snapshot.
    expect(sandboxes.get("dst")?.spec.source).toEqual({
      snapshot: expect.stringMatching(/^snap-/),
    });
    expect(snapshots.list().filter((s) => s.sandboxId === "dst")).toHaveLength(
      0,
    );
    await expect(runtime.resume("dst")).rejects.toThrow(
      /Snapshot .* not found/,
    );
    expect(sandboxes.get("src")?.status).toBe("running");
  });

  test("a failing boot keeps the copy's snapshot: `error`, then resumable", async () => {
    const backend = new KubernetesBackend();
    const sandboxes = new stores.InMemorySandboxStore();
    const snapshots = new stores.InMemorySnapshotStore();
    const runtime = new RuntimeService({
      backend,
      sandboxes,
      snapshots,
      toolsets: new stores.InMemoryToolsetStore(),
      sandboxToolsetRefs: new stores.InMemorySandboxToolsetRefStore(),
    });
    await runtime.create(spec, { id: "src" });
    const realBoot = backend.boot.bind(backend);
    let sweeps = 0;
    let restartableDeletes = 0;
    backend.cleanup = async () => {
      sweeps++;
      return true;
    };
    backend.deleteRestartable = async () => {
      restartableDeletes++;
    };
    const bootInputs: { preserveDisk?: boolean }[] = [];
    backend.boot = async () => {
      throw new Error("boot boom");
    };
    await expect(
      runtime.fork("src", forkWith(), { id: "dst" }),
    ).rejects.toThrow("boot boom");
    expect(sandboxes.get("dst")?.status).toBe("error");
    // Pod-level teardown only: the label sweep would delete the snapshot.
    expect(sweeps).toBe(0);
    expect(restartableDeletes).toBe(1);
    expect(snapshots.list().filter((s) => s.sandboxId === "dst")).toHaveLength(
      1,
    );

    backend.boot = (id, bootSpec, input, agent) => {
      bootInputs.push(input);
      return realBoot(id, bootSpec, input, agent);
    };
    await runtime.resume("dst");
    expect(sandboxes.get("dst")?.status).toBe("running");
    expect(bootInputs[0]?.preserveDisk).toBe(true);

    // Destroy still GCs it.
    await runtime.destroy("dst");
    expect(snapshots.list().filter((s) => s.sandboxId === "dst")).toHaveLength(
      0,
    );
  });

  test("a failing derive ends the copy in `error`", async () => {
    const { runtime, sandboxes } = makeRuntime();
    await runtime.create(spec, { id: "src" });
    const pending = runtime.fork(
      "src",
      {
        ...forkWith(() => {
          throw new Error("derive boom");
        }),
      },
      { id: "dst" },
    );
    expect(sandboxes.get("dst")?.status).toBe("creating");
    await expect(pending).rejects.toThrow("derive boom");
    expect(sandboxes.get("dst")?.status).toBe("error");
  });

  test("a derive failure leaves the caller's labels, never the source owner's", async () => {
    const { runtime, sandboxes } = makeRuntime();
    await runtime.create(
      {
        ...spec,
        metadata: { "atelier.dev/owner-id": "alice" },
        files: [
          { path: "/etc/gitconfig", content: "[user] name = alice" },
          { path: "/etc/sandbox/secrets/git-credentials", content: "tok" },
          { path: "/etc/keep", content: "kept" },
        ],
        annotations: {
          "atelier.dev/owner": "alice",
          "atelier.dev/owner-email": "alice@x.test",
          "atelier.dev/name": "src",
        },
      },
      { id: "src" },
    );
    await expect(
      runtime.fork(
        "src",
        {
          derive: () => {
            throw new Error("derive boom");
          },
          initial: {
            metadata: { "atelier.dev/owner-id": "bob" },
            annotations: { "atelier.dev/name": "copy" },
          },
        },
        { id: "dst" },
      ),
    ).rejects.toThrow("derive boom");
    const copy = sandboxes.get("dst");
    expect(copy?.status).toBe("error");
    expect(copy?.metadata).toEqual({ "atelier.dev/owner-id": "bob" });
    expect(copy?.spec.annotations).toEqual({ "atelier.dev/name": "copy" });
    expect(copy?.spec.files?.map((f) => f.path)).toEqual(["/etc/keep"]);
  });

  test("a derived spec with an unresolved secret ends the copy in `error`", async () => {
    const { runtime, sandboxes } = makeRuntime();
    await runtime.create(spec, { id: "src" });
    await expect(
      runtime.fork(
        "src",
        {
          ...forkWith((source) => ({
            spec: { ...source, env: { K: { $secret: "NAME" } } },
          })),
        },
        { id: "dst" },
      ),
    ).rejects.toThrow();
    expect(sandboxes.get("dst")?.status).toBe("error");
  });

  test("a failing cleanup neither masks the error nor strands `creating`", async () => {
    const backend = new KubernetesBackend();
    backend.volumes.snapshot = async () => {
      throw new Error("snapshot boom");
    };
    backend.cleanup = async () => {
      throw new Error("sweep boom");
    };
    const sandboxes = new stores.InMemorySandboxStore();
    const runtime = new RuntimeService({
      backend,
      sandboxes,
      snapshots: new stores.InMemorySnapshotStore(),
      toolsets: new stores.InMemoryToolsetStore(),
      sandboxToolsetRefs: new stores.InMemorySandboxToolsetRefStore(),
    });
    await runtime.create(spec, { id: "src" });
    await expect(
      runtime.fork("src", forkWith(), { id: "dst" }),
    ).rejects.toThrow("snapshot boom");
    expect(sandboxes.get("dst")?.status).toBe("error");
  });

  test("a failing boot teardown does not mask the boot error", async () => {
    const backend = new KubernetesBackend();
    const sandboxes = new stores.InMemorySandboxStore();
    const runtime = new RuntimeService({
      backend,
      sandboxes,
      snapshots: new stores.InMemorySnapshotStore(),
      toolsets: new stores.InMemoryToolsetStore(),
      sandboxToolsetRefs: new stores.InMemorySandboxToolsetRefStore(),
    });
    await runtime.create(spec, { id: "src" });
    backend.boot = async () => {
      throw new Error("boot boom");
    };
    backend.deleteRestartable = async () => {
      throw new Error("teardown boom");
    };
    await expect(
      runtime.fork("src", forkWith(), { id: "dst" }),
    ).rejects.toThrow("boot boom");
    expect(sandboxes.get("dst")?.status).toBe("error");
  });

  test("an unknown or non-snapshottable source creates no copy record", async () => {
    const { runtime, sandboxes } = makeRuntime();
    expect(() => runtime.assertSnapshottable("nope")).toThrow(NotFoundError);
    await expect(
      runtime.fork("nope", forkWith(), { id: "dst" }),
    ).rejects.toThrow(NotFoundError);
    await runtime.create(spec, { id: "src" });
    sandboxes.update("src", { status: "error" });
    expect(() => runtime.assertSnapshottable("src")).toThrow(ConflictError);
    await expect(
      runtime.fork("src", forkWith(), { id: "dst" }),
    ).rejects.toThrow(ConflictError);
    expect(sandboxes.get("dst")).toBeUndefined();
  });
});
