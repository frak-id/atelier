/**
 * Snapshot bookkeeping shared by the lifecycle, prebuild and toolset code:
 * naming, "who still needs this ref", and removal (VolumeSnapshot + row).
 */
import { createHash } from "node:crypto";
import { safeNanoid } from "../shared/lib/id.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { SandboxBackend } from "./backend/index.ts";
import type { SandboxStore, SnapshotStore } from "./store.ts";

const log = createChildLogger("runtime-snapshots");

/** A fresh snapshot identity (hash + `snap-…` ref) owned by `ownerId`. The
 * nonce keeps two snapshots taken in the same millisecond apart. */
export function newSnapshotName(ownerId: string): {
  hash: string;
  ref: string;
} {
  const hash = createHash("sha256")
    .update(`${ownerId}:${Date.now()}:${safeNanoid()}`)
    .digest("hex");
  return { hash, ref: `snap-${hash.slice(0, 12)}` };
}

/** Refs that must not be deleted: a sandbox boots from them
 * (`source.snapshot`) or another snapshot is chained on them (`parent`). */
export function referencedSnapshotRefs(
  sandboxes: SandboxStore,
  snapshots: SnapshotStore,
): Set<string> {
  const refs = new Set<string>();
  for (const s of sandboxes.list()) {
    if ("snapshot" in s.spec.source) refs.add(s.spec.source.snapshot);
  }
  for (const snap of snapshots.list()) {
    if (snap.parent) refs.add(snap.parent);
  }
  return refs;
}

/** Drop a snapshot's VolumeSnapshot then its record. The backend delete is
 * best-effort (an already-gone object must still clear the row). */
export async function removeSnapshot(
  backend: SandboxBackend,
  snapshots: SnapshotStore,
  ref: string,
): Promise<void> {
  await backend.volumes.deleteSnapshot(ref);
  snapshots.delete(ref);
  log.info({ ref }, "snapshot deleted");
}
