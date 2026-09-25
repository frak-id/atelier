/**
 * Force-erase: hard delete of a record and everything derived from it
 * (`docs/research/company-agent-prior-art.md` §4). Runs as one transaction
 * so a crash mid-cascade never leaves half-erased state; hooks for
 * external artifacts (cached transcripts, a skill PR, …) run after commit
 * since they cannot be rolled back anyway.
 */
import type { KnowledgeDb } from "./db.ts";
import { Derivations } from "./derivations.ts";
import type { ErasureHook, ErasureReport, RecordRef } from "./types.ts";

const refKey = (ref: RecordRef): string => `${ref.kind}:${ref.id}`;

function eraseEmbeddings(
  db: KnowledgeDb,
  owner: RecordRef,
  report: ErasureReport,
): void {
  const row = db
    .query(
      `SELECT COUNT(*) as n FROM embeddings
       WHERE owner_kind = $ownerKind AND owner_id = $ownerId`,
    )
    .get({ ownerKind: owner.kind, ownerId: owner.id }) as { n: number };
  if (row.n === 0) return;
  db.query(
    `DELETE FROM embeddings
     WHERE owner_kind = $ownerKind AND owner_id = $ownerId`,
  ).run({ ownerKind: owner.kind, ownerId: owner.id });
  report.erased.push({ kind: "embedding", id: `${owner.kind}:${owner.id}` });
}

function eraseFactsFromSource(
  db: KnowledgeDb,
  sourceKey: string,
  report: ErasureReport,
): void {
  const rows = db
    .query("SELECT id FROM facts WHERE source_key = $sourceKey")
    .all({ sourceKey }) as { id: string }[];
  if (rows.length === 0) return;
  db.query("DELETE FROM facts WHERE source_key = $sourceKey").run({
    sourceKey,
  });
  for (const row of rows) report.erased.push({ kind: "fact", id: row.id });
}

function eraseOne(
  db: KnowledgeDb,
  ref: RecordRef,
  report: ErasureReport,
): void {
  switch (ref.kind) {
    case "memory":
      db.query("DELETE FROM memories WHERE id = $id").run({ id: ref.id });
      report.erased.push(ref);
      eraseEmbeddings(db, ref, report);
      eraseFactsFromSource(db, `memory:${ref.id}`, report);
      return;
    case "entity":
      db.query("DELETE FROM entities WHERE id = $id").run({ id: ref.id });
      report.erased.push(ref);
      eraseEmbeddings(db, ref, report);
      return;
    case "fact":
      db.query("DELETE FROM facts WHERE id = $id").run({ id: ref.id });
      report.erased.push(ref);
      return;
    case "document":
      db.query("DELETE FROM documents WHERE id = $id").run({ id: ref.id });
      report.erased.push(ref);
      eraseEmbeddings(db, ref, report);
      return;
    case "embedding": {
      const [ownerKind, ownerId] = ref.id.split(":");
      if (ownerKind && ownerId) {
        db.query(
          `DELETE FROM embeddings
           WHERE owner_kind = $ownerKind AND owner_id = $ownerId`,
        ).run({ ownerKind, ownerId });
      }
      report.erased.push(ref);
      return;
    }
    case "external":
      report.external.push(ref);
      return;
  }
}

/**
 * Erases `roots` and every record transitively derived from them, in one
 * transaction. Returns a report of what was deleted (for `external`
 * records, what the caller must clean up itself) and then runs `hooks`
 * against that report — after commit, since they cannot participate in it.
 */
export async function eraseRecords(
  db: KnowledgeDb,
  roots: RecordRef[],
  opts?: { hooks?: ErasureHook[] },
): Promise<ErasureReport> {
  const derivations = new Derivations(db);
  const report: ErasureReport = { roots, erased: [], external: [] };

  const run = db.transaction(() => {
    const seen = new Set<string>();
    const all: RecordRef[] = [];
    for (const root of roots) {
      const key = refKey(root);
      if (!seen.has(key)) {
        seen.add(key);
        all.push(root);
      }
      for (const child of derivations.descendants(root)) {
        const childKey = refKey(child);
        if (seen.has(childKey)) continue;
        seen.add(childKey);
        all.push(child);
      }
    }

    for (const ref of all) {
      eraseOne(db, ref, report);
      derivations.removeAll(ref);
    }
  });
  run();

  if (opts?.hooks) {
    for (const hook of opts.hooks) {
      await hook.onErase(report);
    }
  }
  return report;
}
