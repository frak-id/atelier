/**
 * Runtime's tables. Per atelier-v2 §3.1: `sandboxes(id, spec, status,
 * generated, metadata)` and `snapshots(hash, parent, ref)` — deliberately NO
 * FK to any identity table. `control/` treats the runtime as an
 * authenticated principal it talks to, not a database it joins against, and
 * the reverse holds too: these tables carry no `orgId`/`userId` column.
 *
 * `spec`/`generated`/`metadata` are opaque JSON blobs from the runtime's own
 * point of view — it stores and returns them without interpreting their
 * shape beyond what `RuntimeService` already does in memory.
 */
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sandboxes = sqliteTable("sandboxes", {
  id: text("id").primaryKey(),
  /** JSON: the resolved `SandboxSpec` this sandbox was booted from. */
  spec: text("spec").notNull(),
  status: text("status").notNull(),
  /** JSON: runtime-generated values (agent password, pod IP, tokens). */
  generated: text("generated").notNull(),
  /** JSON: opaque pass-through, threaded for observability, never read. */
  metadata: text("metadata").notNull(),
  podName: text("pod_name"),
  pvcName: text("pvc_name"),
  /** VolumeSnapshot ref the last `pause()` produced — the resume boot source. */
  pauseSnapshotRef: text("pause_snapshot_ref"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const snapshots = sqliteTable(
  "snapshots",
  {
    /** VolumeSnapshot name to clone a PVC from — the primary handle. */
    ref: text("ref").primaryKey(),
    /** Content hash the snapshot is keyed by (prebuild idempotency lookup). */
    hash: text("hash").notNull(),
    /** Base OCI image the snapshot was built on. */
    image: text("image").notNull(),
    /** Parent snapshot ref in the chain, if this snapshot was derived. */
    parent: text("parent"),
    /** Owning sandbox for sandbox-scoped snapshots (pause/manual) — their
     * VolumeSnapshots carry the sandbox label and are swept on destroy, so
     * the rows must go with them. Null for shared prebuild snapshots. */
    sandboxId: text("sandbox_id"),
    /** JSON: opaque `PrebuildSpec.metadata` pass-through (workspace, repo…). */
    metadata: text("metadata"),
    /** JSON: the original PrebuildSpec, so a prebuild can be replayed/refreshed. */
    spec: text("spec"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("idx_snapshots_hash").on(t.hash)],
);

/**
 * A registered/built base image (docs review: "base images as first-class
 * server content"). Three `provenance` values:
 *   - `seed`: built from an embedded seed context (`registry/seeds/`),
 *     `seedId` names it.
 *   - `dockerfile`: built from a user-supplied Dockerfile (pasted or from an
 *     uploaded zip's context) — `dockerfile` holds the content so a rebuild
 *     can replay it.
 *   - `external`: a pure reference (e.g. a GHCR image) registered without a
 *     build — `ref` is the verbatim user-given ref, `status` is `ready`
 *     immediately, `digest`/`dockerfile`/`seedId` stay null.
 * `name` is the destination repo name (`${registryUrl}/<name>`) and the sole
 * identity — builds are dedup'd/looked-up by it, mirroring how `snapshots`
 * dedupe by content hash. No FK (runtime's tables carry none, see header).
 */
export const images = sqliteTable("images", {
  name: text("name").primaryKey(),
  provenance: text("provenance").notNull(),
  status: text("status").notNull(),
  /** Digest-pinned pull ref once `ready` (`<registry>/<name>@sha256:...`);
   * the verbatim user-given ref for `external`. Null while `building`. */
  ref: text("ref"),
  /** Which embedded seed this was built from, when `provenance=seed`. */
  seedId: text("seed_id"),
  /** The Dockerfile content built, when `provenance=dockerfile` — kept so a
   * "rebuild" action can replay it without the caller re-submitting it. */
  dockerfile: text("dockerfile"),
  /** The `sha256:...` digest resolved after a successful build/push. */
  digest: text("digest"),
  /** Last-N lines of build output, for the images page/CLI to show without
   * requiring the build's live `/logs` stream to still be open. */
  buildLog: text("build_log"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * A long-running runtime operation, made durable and observable — the read
 * model behind `GET /v1/jobs` + the `/v1/jobs/events` SSE feed. Every
 * multi-second/minute op the api/ seam dispatches (prebuild bake, toolset
 * build, toolset/version capture) gets a row here so a client can poll or
 * subscribe instead of holding a blocking request open.
 *
 * Global by design (no `orgId`/`userId` — the runtime carries no identity FK,
 * see this file's header): the queue is a single shared view for now.
 *
 * A crash/restart is fatal to the in-flight work (the AbortController and its
 * promise die with the process), so `reconcileOnStartup()` sweeps every
 * `running` row to `failed` with a "rebooted" reason at boot — mirroring the
 * `images`/`sandboxes` zombie sweeps.
 */
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    /** The `JobKind` union (see `store.ts`) — a pooled build (`prebuild`,
     * `toolset-*`) or a tracked `sandbox-*` lifecycle op. */
    kind: text("kind").notNull(),
    /** The `JobStatus` union (see `store.ts`): queued → running → succeeded/
     * failed/canceled. */
    status: text("status").notNull(),
    /** Human-facing label (prebuild name, toolset name) for the queue UI. */
    target: text("target"),
    /** JSON: opaque pass-through context for display (repo, slug, …). */
    metadata: text("metadata"),
    /** JSON: the operation's success result (e.g. `{ ref }`). Null until done. */
    result: text("result"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    /** Set when the job settles (succeeded/failed/canceled) — for duration. */
    finishedAt: text("finished_at"),
  },
  (t) => [index("idx_jobs_status").on(t.status)],
);

export const toolsets = sqliteTable(
  "toolsets",
  {
    /** Content/result hash the toolset is keyed by (build idempotency lookup). */
    hash: text("hash").primaryKey(),
    /** Registry identity (the artifact repo name). */
    name: text("name").notNull(),
    /** Host-relative OCI locator (`toolsets/<name>@sha256:…`) — the pull handle. */
    ref: text("ref").notNull(),
    /** JSON: home path-sets the artifact materializes into. */
    paths: text("paths").notNull(),
    /** JSON: env fragment merged at compose time (nullable). */
    env: text("env"),
    /** JSON: `ToolsetProvenance` (built | captured). */
    provenance: text("provenance").notNull(),
    /** 1 = private-to-capturer (captures default), 0 = published. */
    private: integer("private").notNull(),
    createdAt: text("created_at").notNull(),
  },
  // Secondary lookup key for publish/delete/resolve by ref. NOT unique: two
  // distinct build hashes can yield byte-identical artifacts under the same
  // name (→ same `name@digest` ref), which a UNIQUE index would reject on a
  // legitimate build. The index only bounds the lookup cost.
  (t) => [index("idx_toolsets_ref").on(t.ref)],
);

/**
 * Which toolset refs each sandbox has mounted (toolset-overlay-squashfs.md
 * §6-7) — a many-to-many join, deliberately not a column on `sandboxes` (one
 * toolset can be referenced by many sandboxes) and not a column on
 * `toolsets` (one sandbox mounts many toolsets). Sole job: GC guard —
 * `referencedRefs()` refuses to delete a `toolsets` row a live/paused
 * sandbox still depends on (mirrors `snapshots.sandboxId`, but many-to-many
 * instead of one-owner). `resume()` does NOT read this table — it
 * re-derives its toolset list fresh from `spec.toolsets` (no registry call,
 * just string concatenation), so this table carries no `digest` column (H4:
 * a prior denormalized copy went unread and was removed).
 * No FK (runtime's tables carry no FK per this file's header); rows are
 * replaced wholesale per sandboxId on every successful boot and dropped on
 * destroy, so staleness is bounded to a single boot's lifetime.
 */
export const sandboxToolsetRefs = sqliteTable(
  "sandbox_toolset_refs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sandboxId: text("sandbox_id").notNull(),
    /** Full, digest-pinned pull reference (`<registry>/toolsets/<name>@sha256:…`). */
    ref: text("ref").notNull(),
  },
  (t) => [
    index("idx_sandbox_toolset_refs_sandbox").on(t.sandboxId),
    index("idx_sandbox_toolset_refs_ref").on(t.ref),
  ],
);
