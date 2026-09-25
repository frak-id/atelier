/**
 * The `derived_from` link table erasure walks: `child` was produced from
 * `parent` (a document chunked from a memory, an embedding of an entity, …).
 * Erasing `parent` must erase every transitive `child`.
 */
import type { KnowledgeDb } from "./db.ts";
import type { RecordRef } from "./types.ts";

const refKey = (ref: RecordRef): string => `${ref.kind}:${ref.id}`;

export class Derivations {
  constructor(private readonly db: KnowledgeDb) {}

  /** Idempotent: linking the same pair twice is a no-op. */
  link(parent: RecordRef, child: RecordRef, opts?: { now?: number }): void {
    this.db
      .query(
        `INSERT INTO derivations
           (parent_kind, parent_id, child_kind, child_id, created_at)
         VALUES ($parentKind, $parentId, $childKind, $childId, $createdAt)
         ON CONFLICT (parent_kind, parent_id, child_kind, child_id)
         DO NOTHING`,
      )
      .run({
        parentKind: parent.kind,
        parentId: parent.id,
        childKind: child.kind,
        childId: child.id,
        createdAt: opts?.now ?? Date.now(),
      });
  }

  children(ref: RecordRef): RecordRef[] {
    return this.db
      .query(
        `SELECT child_kind as kind, child_id as id FROM derivations
         WHERE parent_kind = $kind AND parent_id = $id`,
      )
      .all({ kind: ref.kind, id: ref.id }) as RecordRef[];
  }

  parents(ref: RecordRef): RecordRef[] {
    return this.db
      .query(
        `SELECT parent_kind as kind, parent_id as id FROM derivations
         WHERE child_kind = $kind AND child_id = $id`,
      )
      .all({ kind: ref.kind, id: ref.id }) as RecordRef[];
  }

  /** Transitive closure of `children`, cycle-safe, `ref` itself excluded. */
  descendants(ref: RecordRef): RecordRef[] {
    const seen = new Set<string>([refKey(ref)]);
    const result: RecordRef[] = [];
    const queue: RecordRef[] = [ref];
    let current: RecordRef | undefined;
    // biome-ignore lint/suspicious/noAssignInExpressions: BFS pop
    while ((current = queue.shift())) {
      for (const child of this.children(current)) {
        const key = refKey(child);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(child);
        queue.push(child);
      }
    }
    return result;
  }

  /** Drops every row where `ref` is either side (used by erasure). */
  removeAll(ref: RecordRef): void {
    this.db
      .query(
        `DELETE FROM derivations
         WHERE (parent_kind = $kind AND parent_id = $id)
            OR (child_kind = $kind AND child_id = $id)`,
      )
      .run({ kind: ref.kind, id: ref.id });
  }
}
