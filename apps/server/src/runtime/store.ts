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
import type { Generated, SandboxSpec, SandboxStatus } from "@atelier/spec";
import { eq } from "drizzle-orm";
import { getDatabase } from "../shared/lib/db.ts";
import { sandboxes, snapshots } from "./db/schema.ts";

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
  createdAt: string;
}

function snapshotRowToRecord(row: SnapshotRow): SnapshotRecord {
  return {
    ref: row.ref,
    hash: row.hash,
    image: row.image,
    parent: row.parent ?? undefined,
    createdAt: row.createdAt,
  };
}

function snapshotRecordToRow(record: SnapshotRecord): SnapshotRow {
  return {
    ref: record.ref,
    hash: record.hash,
    image: record.image,
    parent: record.parent ?? null,
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
}
