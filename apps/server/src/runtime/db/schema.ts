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
