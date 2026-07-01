/**
 * Runtime-owned state. Per atelier-v2 §3.1, the runtime's tables are
 * `sandboxes(id, spec, status, generated, metadata)` and
 * `snapshots(hash, parent, ref)` — with NO FK to any identity table. Callers
 * are just "authenticated principals" to it.
 *
 * Phase 0 uses an in-memory implementation so `runtime/` compiles and runs
 * standalone (the future extraction seam). A persistent backend swaps in
 * behind `SandboxStore` without touching callers.
 */
import type { Generated, SandboxSpec, SandboxStatus } from "@atelier/spec";

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
