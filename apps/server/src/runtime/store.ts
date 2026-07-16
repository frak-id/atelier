/**
 * Runtime-owned state. Per atelier-v2 §3.1, the runtime's tables are
 * `sandboxes(id, spec, status, generated, metadata)` and
 * `snapshots(hash, parent, ref)` — with NO FK to any identity table. Callers
 * are just "authenticated principals" to it.
 *
 * `InMemory*` stores keep `runtime/` runnable standalone (tests, the
 * future extraction seam). `Drizzle*` stores persist to the same sqlite file
 * `control/` uses, in their own tables — see `./db/schema.ts`. Both sets
 * implement the same synchronous interface (bun:sqlite/drizzle bun-sqlite
 * queries are synchronous, and `RuntimeService` calls them as such).
 */
import type {
  Generated,
  PrebuildSpec,
  SandboxSpec,
  SandboxStatus,
  ToolsetEntry,
} from "@atelier/spec";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { getDatabase } from "../shared/lib/db.ts";
import {
  images,
  jobs,
  sandboxes,
  sandboxToolsetRefs,
  snapshots,
  toolsets,
} from "./db/schema.ts";

export interface SandboxRecord {
  id: string;
  spec: SandboxSpec;
  status: SandboxStatus;
  generated: Generated;
  /** Opaque, pass-through. Threaded for observability, never read. */
  metadata: Record<string, string>;
  podName?: string;
  pvcName?: string;
  /** VolumeSnapshot ref the last `pause()` produced — what `resume()` boots
   * from. Cleared on successful resume (the PVC is live again). */
  pauseSnapshotRef?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SnapshotRecord {
  hash: string;
  /** VolumeSnapshot name to clone a PVC from. */
  ref: string;
  /** Base OCI image the snapshot was built on (pods boot from this exact image). */
  image: string;
  parent?: string;
  /** Owning sandbox for sandbox-scoped snapshots (pause/manual). Their
   * VolumeSnapshots carry the `atelier.dev/sandbox` label — destroy's sweep
   * deletes them, so their rows are deleted alongside. Unset for shared
   * prebuild snapshots (component label only; survive sandbox destroy). */
  sandboxId?: string;
  /** Opaque `PrebuildSpec.metadata` pass-through (workspace, repo, branch…). */
  metadata?: Record<string, string>;
  /** The original request, so a prebuild can be replayed/refreshed. */
  spec?: PrebuildSpec;
  createdAt: string;
}

export interface SandboxStore {
  create(record: SandboxRecord): void;
  get(id: string): SandboxRecord | undefined;
  update(id: string, patch: Partial<SandboxRecord>): SandboxRecord | undefined;
  delete(id: string): void;
  list(): SandboxRecord[];
}

export interface SnapshotStore {
  getByHash(hash: string): SnapshotRecord | undefined;
  put(record: SnapshotRecord): void;
  get(ref: string): SnapshotRecord | undefined;
  list(): SnapshotRecord[];
  delete(ref: string): void;
  /** Drop every row owned by a sandbox (destroy's label sweep just deleted
   * their VolumeSnapshots). */
  deleteBySandbox(sandboxId: string): void;
}

/** Provenance of an `ImageRecord` — see `db/schema.ts`'s `images` table doc
 * for what each means. */
export type ImageProvenance = "seed" | "dockerfile" | "external";
export type ImageStatus = "building" | "ready" | "error";

/** A registered/built base image — the read+write model behind `GET/POST
 * /v1/images`. `name` is the sole identity (the destination repo name). */
export interface ImageRecord {
  name: string;
  provenance: ImageProvenance;
  status: ImageStatus;
  /** Digest-pinned pull ref once `ready`; the verbatim ref for `external`. */
  ref?: string;
  /** Which embedded seed this was built from, when `provenance="seed"`. */
  seedId?: string;
  /** The Dockerfile content built, when `provenance="dockerfile"` — kept so
   * a rebuild can replay it. */
  dockerfile?: string;
  digest?: string;
  /** Last-N lines of build output. */
  buildLog?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ImageStore {
  get(name: string): ImageRecord | undefined;
  put(record: ImageRecord): void;
  update(name: string, patch: Partial<ImageRecord>): ImageRecord | undefined;
  list(): ImageRecord[];
  delete(name: string): void;
}

/** A published toolset artifact keyed by its content/result `hash`. */
export interface ToolsetRecord extends ToolsetEntry {
  /** Content hash (built) or result hash (captured) — the dedup key. */
  hash: string;
}

export interface ToolsetStore {
  getByHash(hash: string): ToolsetRecord | undefined;
  getByRef(ref: string): ToolsetRecord | undefined;
  put(record: ToolsetRecord): void;
  list(): ToolsetRecord[];
  delete(hash: string): void;
}

/** One mounted toolset on one sandbox — the many-to-many join
 * (toolset-overlay-squashfs.md §6-7): resume re-mounts from `getForSandbox`,
 * the GC guard refuses to delete a ref in `referencedRefs()`. */
export interface SandboxToolsetRefEntry {
  ref: string;
  digest: string;
}

export interface SandboxToolsetRefStore {
  /** Replace-all: the full set of toolsets a sandbox has mounted, as of its
   * last successful boot (create or resume). */
  putForSandbox(sandboxId: string, entries: SandboxToolsetRefEntry[]): void;
  getForSandbox(sandboxId: string): SandboxToolsetRefEntry[];
  deleteBySandbox(sandboxId: string): void;
  /** Every ref mounted by at least one sandbox (live or paused), for the
   * `deleteToolset` GC guard. */
  referencedRefs(): Set<string>;
}

/** The long-running operations tracked by `JobService` (see `db/schema.ts`'s
 * `jobs` table doc). Global, no identity scope. The `sandbox-*` kinds are
 * lifecycle ops tracked for feed visibility (they bypass the concurrency
 * pool); the rest are pooled throwaway-pod builds. */
export type JobKind =
  | "prebuild"
  | "toolset-build"
  | "toolset-capture"
  | "image-build"
  | "sandbox-create"
  | "sandbox-pause"
  | "sandbox-resume"
  | "sandbox-snapshot"
  | "sandbox-destroy";
/** `queued` = waiting for a concurrency slot (pooled jobs only). */
export type JobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

/** The settled (non-cancellable, non-active) states. */
export function isJobTerminal(status: JobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  status: JobStatus;
  /** Human-facing label for the queue UI (prebuild/toolset name). */
  target?: string;
  /** Opaque display context (repo, slug, …). */
  metadata?: Record<string, string>;
  /** The operation's success payload (e.g. `{ ref }`), once `succeeded`. */
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export interface JobStore {
  create(record: JobRecord): void;
  get(id: string): JobRecord | undefined;
  update(id: string, patch: Partial<JobRecord>): JobRecord | undefined;
  /** Newest first. `limit` caps the number of rows returned (the table is
   * unbounded history; callers/endpoints want a recent tail). */
  list(limit?: number): JobRecord[];
  /** Bulk-settle every non-terminal row (`queued`/`running`) at boot — the
   * restart sweep (their in-memory promise + queue entry died with the
   * process). Returns the ids it transitioned so the caller can log/emit. */
  failActive(reason: string): string[];
  /** Retention: delete settled rows that finished before `beforeIso`. Returns
   * how many were removed. Never touches non-terminal rows. */
  deleteTerminalBefore(beforeIso: string): number;
}

// ── in-memory (tests, standalone runtime/) ─────────────────────────────────

export class InMemorySandboxStore implements SandboxStore {
  private readonly rows = new Map<string, SandboxRecord>();

  create(record: SandboxRecord): void {
    this.rows.set(record.id, record);
  }
  get(id: string): SandboxRecord | undefined {
    return this.rows.get(id);
  }
  update(id: string, patch: Partial<SandboxRecord>) {
    const row = this.rows.get(id);
    if (!row) return undefined;
    const next = { ...row, ...patch, updatedAt: new Date().toISOString() };
    this.rows.set(id, next);
    return next;
  }
  delete(id: string): void {
    this.rows.delete(id);
  }
  list(): SandboxRecord[] {
    return [...this.rows.values()];
  }
}

export class InMemoryToolsetStore implements ToolsetStore {
  private readonly byHash = new Map<string, ToolsetRecord>();
  private readonly byRef = new Map<string, ToolsetRecord>();

  getByHash(hash: string): ToolsetRecord | undefined {
    return this.byHash.get(hash);
  }
  getByRef(ref: string): ToolsetRecord | undefined {
    return this.byRef.get(ref);
  }
  put(record: ToolsetRecord): void {
    const prior = this.byHash.get(record.hash);
    if (prior && prior.ref !== record.ref) this.byRef.delete(prior.ref);
    this.byHash.set(record.hash, record);
    this.byRef.set(record.ref, record);
  }
  list(): ToolsetRecord[] {
    return [...this.byHash.values()];
  }
  delete(hash: string): void {
    const prior = this.byHash.get(hash);
    this.byHash.delete(hash);
    if (prior) this.byRef.delete(prior.ref);
  }
}

export class InMemorySandboxToolsetRefStore implements SandboxToolsetRefStore {
  private readonly bySandbox = new Map<string, SandboxToolsetRefEntry[]>();

  putForSandbox(sandboxId: string, entries: SandboxToolsetRefEntry[]): void {
    this.bySandbox.set(sandboxId, entries);
  }
  getForSandbox(sandboxId: string): SandboxToolsetRefEntry[] {
    return this.bySandbox.get(sandboxId) ?? [];
  }
  deleteBySandbox(sandboxId: string): void {
    this.bySandbox.delete(sandboxId);
  }
  referencedRefs(): Set<string> {
    const refs = new Set<string>();
    for (const entries of this.bySandbox.values()) {
      for (const e of entries) refs.add(e.ref);
    }
    return refs;
  }
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly byRef = new Map<string, SnapshotRecord>();
  private readonly byHash = new Map<string, SnapshotRecord>();

  getByHash(hash: string): SnapshotRecord | undefined {
    return this.byHash.get(hash);
  }
  get(ref: string): SnapshotRecord | undefined {
    return this.byRef.get(ref);
  }
  put(record: SnapshotRecord): void {
    this.byRef.set(record.ref, record);
    this.byHash.set(record.hash, record);
  }
  list(): SnapshotRecord[] {
    return [...this.byRef.values()];
  }
  deleteBySandbox(sandboxId: string): void {
    for (const record of this.byRef.values()) {
      if (record.sandboxId === sandboxId) this.delete(record.ref);
    }
  }
  delete(ref: string): void {
    const prior = this.byRef.get(ref);
    this.byRef.delete(ref);
    if (prior) this.byHash.delete(prior.hash);
  }
}

export class InMemoryImageStore implements ImageStore {
  private readonly byName = new Map<string, ImageRecord>();

  get(name: string): ImageRecord | undefined {
    return this.byName.get(name);
  }
  put(record: ImageRecord): void {
    this.byName.set(record.name, record);
  }
  update(name: string, patch: Partial<ImageRecord>): ImageRecord | undefined {
    const existing = this.byName.get(name);
    if (!existing) return undefined;
    const next: ImageRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.byName.set(name, next);
    return next;
  }
  list(): ImageRecord[] {
    return [...this.byName.values()];
  }
  delete(name: string): void {
    this.byName.delete(name);
  }
}

export class InMemoryJobStore implements JobStore {
  private readonly rows = new Map<string, JobRecord>();

  create(record: JobRecord): void {
    this.rows.set(record.id, record);
  }
  get(id: string): JobRecord | undefined {
    return this.rows.get(id);
  }
  update(id: string, patch: Partial<JobRecord>): JobRecord | undefined {
    const existing = this.rows.get(id);
    if (!existing) return undefined;
    const next: JobRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.rows.set(id, next);
    return next;
  }
  list(limit?: number): JobRecord[] {
    const sorted = [...this.rows.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    return limit === undefined ? sorted : sorted.slice(0, limit);
  }
  failActive(reason: string): string[] {
    const ids: string[] = [];
    for (const row of this.rows.values()) {
      if (isJobTerminal(row.status)) continue;
      this.update(row.id, {
        status: "failed",
        error: reason,
        finishedAt: new Date().toISOString(),
      });
      ids.push(row.id);
    }
    return ids;
  }
  deleteTerminalBefore(beforeIso: string): number {
    let removed = 0;
    for (const row of [...this.rows.values()]) {
      if (!isJobTerminal(row.status)) continue;
      if (row.createdAt >= beforeIso) continue;
      this.rows.delete(row.id);
      removed++;
    }
    return removed;
  }
}

// ── sqlite/drizzle-backed (persistent) ─────────────────────────────────────

interface SandboxRow {
  id: string;
  spec: string;
  status: string;
  generated: string;
  metadata: string;
  podName: string | null;
  pvcName: string | null;
  pauseSnapshotRef: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToRecord(row: SandboxRow): SandboxRecord {
  return {
    id: row.id,
    spec: JSON.parse(row.spec) as SandboxSpec,
    status: row.status as SandboxStatus,
    generated: JSON.parse(row.generated) as Generated,
    metadata: JSON.parse(row.metadata) as Record<string, string>,
    podName: row.podName ?? undefined,
    pvcName: row.pvcName ?? undefined,
    pauseSnapshotRef: row.pauseSnapshotRef ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function recordToRow(record: SandboxRecord): SandboxRow {
  return {
    id: record.id,
    spec: JSON.stringify(record.spec),
    status: record.status,
    generated: JSON.stringify(record.generated),
    metadata: JSON.stringify(record.metadata),
    podName: record.podName ?? null,
    pvcName: record.pvcName ?? null,
    pauseSnapshotRef: record.pauseSnapshotRef ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * `getDatabase()` is resolved lazily per query (not cached in the
 * constructor) so this class can be instantiated before `initDatabase()`
 * runs at bootstrap — the same pattern `control/`'s repositories use.
 */
export class DrizzleSandboxStore implements SandboxStore {
  create(record: SandboxRecord): void {
    getDatabase().insert(sandboxes).values(recordToRow(record)).run();
  }

  get(id: string): SandboxRecord | undefined {
    const row = getDatabase()
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.id, id))
      .get() as SandboxRow | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  update(id: string, patch: Partial<SandboxRecord>): SandboxRecord | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const next: SandboxRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    getDatabase()
      .update(sandboxes)
      .set(recordToRow(next))
      .where(eq(sandboxes.id, id))
      .run();
    return next;
  }

  delete(id: string): void {
    getDatabase().delete(sandboxes).where(eq(sandboxes.id, id)).run();
  }

  list(): SandboxRecord[] {
    const rows = getDatabase().select().from(sandboxes).all() as SandboxRow[];
    return rows.map(rowToRecord);
  }
}

interface SnapshotRow {
  ref: string;
  hash: string;
  image: string;
  parent: string | null;
  sandboxId: string | null;
  metadata: string | null;
  spec: string | null;
  createdAt: string;
}

function snapshotRowToRecord(row: SnapshotRow): SnapshotRecord {
  return {
    ref: row.ref,
    hash: row.hash,
    image: row.image,
    parent: row.parent ?? undefined,
    sandboxId: row.sandboxId ?? undefined,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, string>)
      : undefined,
    spec: row.spec ? (JSON.parse(row.spec) as PrebuildSpec) : undefined,
    createdAt: row.createdAt,
  };
}

function snapshotRecordToRow(record: SnapshotRecord): SnapshotRow {
  return {
    ref: record.ref,
    hash: record.hash,
    image: record.image,
    parent: record.parent ?? null,
    sandboxId: record.sandboxId ?? null,
    metadata: record.metadata ? JSON.stringify(record.metadata) : null,
    spec: record.spec ? JSON.stringify(record.spec) : null,
    createdAt: record.createdAt,
  };
}

export class DrizzleSnapshotStore implements SnapshotStore {
  getByHash(hash: string): SnapshotRecord | undefined {
    const row = getDatabase()
      .select()
      .from(snapshots)
      .where(eq(snapshots.hash, hash))
      .get() as SnapshotRow | undefined;
    return row ? snapshotRowToRecord(row) : undefined;
  }

  get(ref: string): SnapshotRecord | undefined {
    const row = getDatabase()
      .select()
      .from(snapshots)
      .where(eq(snapshots.ref, ref))
      .get() as SnapshotRow | undefined;
    return row ? snapshotRowToRecord(row) : undefined;
  }

  /** Upsert by `ref` — a snapshot's identity is its VolumeSnapshot name. */
  put(record: SnapshotRecord): void {
    const db = getDatabase();
    const row = snapshotRecordToRow(record);
    const existing = db
      .select()
      .from(snapshots)
      .where(eq(snapshots.ref, record.ref))
      .get();
    if (existing) {
      db.update(snapshots).set(row).where(eq(snapshots.ref, record.ref)).run();
      return;
    }
    db.insert(snapshots).values(row).run();
  }

  list(): SnapshotRecord[] {
    const rows = getDatabase().select().from(snapshots).all() as SnapshotRow[];
    return rows.map(snapshotRowToRecord);
  }

  delete(ref: string): void {
    getDatabase().delete(snapshots).where(eq(snapshots.ref, ref)).run();
  }

  deleteBySandbox(sandboxId: string): void {
    getDatabase()
      .delete(snapshots)
      .where(eq(snapshots.sandboxId, sandboxId))
      .run();
  }
}

interface ImageRow {
  name: string;
  provenance: string;
  status: string;
  ref: string | null;
  seedId: string | null;
  dockerfile: string | null;
  digest: string | null;
  buildLog: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

function imageRowToRecord(row: ImageRow): ImageRecord {
  return {
    name: row.name,
    provenance: row.provenance as ImageRecord["provenance"],
    status: row.status as ImageRecord["status"],
    ref: row.ref ?? undefined,
    seedId: row.seedId ?? undefined,
    dockerfile: row.dockerfile ?? undefined,
    digest: row.digest ?? undefined,
    buildLog: row.buildLog ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function imageRecordToRow(record: ImageRecord): ImageRow {
  return {
    name: record.name,
    provenance: record.provenance,
    status: record.status,
    ref: record.ref ?? null,
    seedId: record.seedId ?? null,
    dockerfile: record.dockerfile ?? null,
    digest: record.digest ?? null,
    buildLog: record.buildLog ?? null,
    error: record.error ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** Upsert-by-`name` store, mirroring `DrizzleSnapshotStore`'s shape — an
 * image's identity is its destination repo name (see `ImageRecord`). */
export class DrizzleImageStore implements ImageStore {
  get(name: string): ImageRecord | undefined {
    const row = getDatabase()
      .select()
      .from(images)
      .where(eq(images.name, name))
      .get() as ImageRow | undefined;
    return row ? imageRowToRecord(row) : undefined;
  }

  put(record: ImageRecord): void {
    const db = getDatabase();
    const row = imageRecordToRow(record);
    const existing = db
      .select()
      .from(images)
      .where(eq(images.name, record.name))
      .get();
    if (existing) {
      db.update(images).set(row).where(eq(images.name, record.name)).run();
      return;
    }
    db.insert(images).values(row).run();
  }

  update(name: string, patch: Partial<ImageRecord>): ImageRecord | undefined {
    const existing = this.get(name);
    if (!existing) return undefined;
    const next: ImageRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.put(next);
    return next;
  }

  list(): ImageRecord[] {
    const rows = getDatabase().select().from(images).all() as ImageRow[];
    return rows.map(imageRowToRecord);
  }

  delete(name: string): void {
    getDatabase().delete(images).where(eq(images.name, name)).run();
  }
}

interface ToolsetRow {
  hash: string;
  name: string;
  ref: string;
  paths: string;
  env: string | null;
  provenance: string;
  private: number;
  createdAt: string;
}

function toolsetRowToRecord(row: ToolsetRow): ToolsetRecord {
  return {
    hash: row.hash,
    name: row.name,
    ref: row.ref,
    paths: JSON.parse(row.paths) as string[],
    env: row.env ? (JSON.parse(row.env) as Record<string, string>) : undefined,
    provenance: JSON.parse(row.provenance) as ToolsetEntry["provenance"],
    private: row.private !== 0,
    createdAt: row.createdAt,
  };
}

function toolsetRecordToRow(record: ToolsetRecord): ToolsetRow {
  return {
    hash: record.hash,
    name: record.name,
    ref: record.ref,
    paths: JSON.stringify(record.paths),
    env: record.env ? JSON.stringify(record.env) : null,
    provenance: JSON.stringify(record.provenance),
    private: record.private ? 1 : 0,
    createdAt: record.createdAt,
  };
}

export class DrizzleToolsetStore implements ToolsetStore {
  getByHash(hash: string): ToolsetRecord | undefined {
    const row = getDatabase()
      .select()
      .from(toolsets)
      .where(eq(toolsets.hash, hash))
      .get() as ToolsetRow | undefined;
    return row ? toolsetRowToRecord(row) : undefined;
  }

  getByRef(ref: string): ToolsetRecord | undefined {
    const row = getDatabase()
      .select()
      .from(toolsets)
      .where(eq(toolsets.ref, ref))
      .get() as ToolsetRow | undefined;
    return row ? toolsetRowToRecord(row) : undefined;
  }

  /** Upsert by `hash` — a toolset's identity is its content/result hash. */
  put(record: ToolsetRecord): void {
    const db = getDatabase();
    const row = toolsetRecordToRow(record);
    const existing = db
      .select()
      .from(toolsets)
      .where(eq(toolsets.hash, record.hash))
      .get();
    if (existing) {
      db.update(toolsets).set(row).where(eq(toolsets.hash, record.hash)).run();
      return;
    }
    db.insert(toolsets).values(row).run();
  }

  list(): ToolsetRecord[] {
    const rows = getDatabase().select().from(toolsets).all() as ToolsetRow[];
    return rows.map(toolsetRowToRecord);
  }

  delete(hash: string): void {
    getDatabase().delete(toolsets).where(eq(toolsets.hash, hash)).run();
  }
}

interface SandboxToolsetRefRow {
  sandboxId: string;
  ref: string;
  digest: string;
}

export class DrizzleSandboxToolsetRefStore implements SandboxToolsetRefStore {
  /** Replace-all in one transaction: delete the sandbox's prior rows, then
   * insert the current mount set — avoids a delete-then-insert race leaving
   * a torn read between the two statements. */
  putForSandbox(sandboxId: string, entries: SandboxToolsetRefEntry[]): void {
    const db = getDatabase();
    db.transaction((tx) => {
      tx.delete(sandboxToolsetRefs)
        .where(eq(sandboxToolsetRefs.sandboxId, sandboxId))
        .run();
      if (entries.length === 0) return;
      tx.insert(sandboxToolsetRefs)
        .values(
          entries.map((e) => ({ sandboxId, ref: e.ref, digest: e.digest })),
        )
        .run();
    });
  }

  getForSandbox(sandboxId: string): SandboxToolsetRefEntry[] {
    const rows = getDatabase()
      .select()
      .from(sandboxToolsetRefs)
      .where(eq(sandboxToolsetRefs.sandboxId, sandboxId))
      .all() as SandboxToolsetRefRow[];
    return rows.map((r) => ({ ref: r.ref, digest: r.digest }));
  }

  deleteBySandbox(sandboxId: string): void {
    getDatabase()
      .delete(sandboxToolsetRefs)
      .where(eq(sandboxToolsetRefs.sandboxId, sandboxId))
      .run();
  }

  referencedRefs(): Set<string> {
    const rows = getDatabase()
      .select({ ref: sandboxToolsetRefs.ref })
      .from(sandboxToolsetRefs)
      .all() as Array<{ ref: string }>;
    return new Set(rows.map((r) => r.ref));
  }
}

interface JobRow {
  id: string;
  kind: string;
  status: string;
  target: string | null;
  metadata: string | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

function jobRowToRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    target: row.target ?? undefined,
    metadata: row.metadata
      ? (JSON.parse(row.metadata) as Record<string, string>)
      : undefined,
    result: row.result ? (JSON.parse(row.result) as unknown) : undefined,
    error: row.error ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finishedAt: row.finishedAt ?? undefined,
  };
}

function jobRecordToRow(record: JobRecord): JobRow {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    target: record.target ?? null,
    metadata: record.metadata ? JSON.stringify(record.metadata) : null,
    result: record.result !== undefined ? JSON.stringify(record.result) : null,
    error: record.error ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    finishedAt: record.finishedAt ?? null,
  };
}

export class DrizzleJobStore implements JobStore {
  create(record: JobRecord): void {
    getDatabase().insert(jobs).values(jobRecordToRow(record)).run();
  }

  get(id: string): JobRecord | undefined {
    const row = getDatabase()
      .select()
      .from(jobs)
      .where(eq(jobs.id, id))
      .get() as JobRow | undefined;
    return row ? jobRowToRecord(row) : undefined;
  }

  update(id: string, patch: Partial<JobRecord>): JobRecord | undefined {
    const existing = this.get(id);
    if (!existing) return undefined;
    const next: JobRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    getDatabase()
      .update(jobs)
      .set(jobRecordToRow(next))
      .where(eq(jobs.id, id))
      .run();
    return next;
  }

  list(limit?: number): JobRecord[] {
    const base = getDatabase()
      .select()
      .from(jobs)
      .orderBy(desc(jobs.createdAt));
    const rows = (
      limit === undefined ? base.all() : base.limit(limit).all()
    ) as JobRow[];
    return rows.map(jobRowToRecord);
  }

  deleteTerminalBefore(beforeIso: string): number {
    const db = getDatabase();
    const doomed = db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          inArray(jobs.status, ["succeeded", "failed", "canceled"]),
          lt(jobs.createdAt, beforeIso),
        ),
      )
      .all() as Array<{ id: string }>;
    if (doomed.length === 0) return 0;
    db.delete(jobs)
      .where(
        inArray(
          jobs.id,
          doomed.map((r) => r.id),
        ),
      )
      .run();
    return doomed.length;
  }

  failActive(reason: string): string[] {
    const db = getDatabase();
    const active = db
      .select({ id: jobs.id })
      .from(jobs)
      .where(inArray(jobs.status, ["queued", "running"]))
      .all() as Array<{ id: string }>;
    if (active.length === 0) return [];
    const now = new Date().toISOString();
    db.update(jobs)
      .set({ status: "failed", error: reason, finishedAt: now, updatedAt: now })
      .where(
        inArray(
          jobs.id,
          active.map((r) => r.id),
        ),
      )
      .run();
    return active.map((r) => r.id);
  }
}
