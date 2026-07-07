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
import { eq } from "drizzle-orm";
import { getDatabase } from "../shared/lib/db.ts";
import { sandboxes, snapshots, toolsets } from "./db/schema.ts";

export interface SandboxRecord {
  id: string;
  spec: SandboxSpec;
  status: SandboxStatus;
  generated: Generated;
  /** Opaque, pass-through. Threaded for observability, never read. */
  metadata: Record<string, string>;
  podName?: string;
  pvcName?: string;
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
  delete(ref: string): void {
    const prior = this.byRef.get(ref);
    this.byRef.delete(ref);
    if (prior) this.byHash.delete(prior.hash);
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
