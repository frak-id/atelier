import { describe, expect, mock, test } from "bun:test";
import { openKnowledgeDb } from "./db.ts";
import { Derivations } from "./derivations.ts";
import { eraseRecords } from "./erasure.ts";

function insertMemory(db: ReturnType<typeof openKnowledgeDb>, id: string) {
  db.query(
    `INSERT INTO memories (
      id, scope_kind, scope_id, kind, content, status, created_by,
      valid_from, created_at, updated_at
    ) VALUES (
      $id, 'org', '', 'fact', 'team payments owns billing', 'active',
      '{"kind":"human","id":"user:a"}', 0, 0, 0
    )`,
  ).run({ id });
}

function insertDocument(db: ReturnType<typeof openKnowledgeDb>, id: string) {
  db.query(
    `INSERT INTO documents (id, collection, title, body, hash, updated_at)
     VALUES ($id, 'c', 'Billing ownership', 'team payments owns billing',
     'h', 0)`,
  ).run({ id });
}

describe("eraseRecords", () => {
  test("cascades through derivations and reports externals", async () => {
    const db = openKnowledgeDb(":memory:");
    const derivations = new Derivations(db);
    insertMemory(db, "m1");
    insertDocument(db, "doc1");
    db.query(
      `INSERT INTO embeddings
         (owner_kind, owner_id, model, dimensions, vector, content_hash,
          created_at)
       VALUES ('document', 'doc1', 'test', 1, x'00', 'h', 0)`,
    ).run();
    db.query(
      `INSERT INTO facts
         (id, type, from_id, to_id, fingerprint, source_key, readers,
          valid_from, recorded_at)
       VALUES ('f1', 'owns', 'team:payments', 'service:billing', 'fp',
       'memory:m1', '[]', 0, 0)`,
    ).run();

    derivations.link(
      { kind: "memory", id: "m1" },
      { kind: "document", id: "doc1" },
    );
    derivations.link(
      { kind: "memory", id: "m1" },
      { kind: "external", id: "skill-pr:42" },
    );

    const onErase = mock((_report: import("./types.ts").ErasureReport) => {});
    const report = await eraseRecords(db, [{ kind: "memory", id: "m1" }], {
      hooks: [{ onErase }],
    });

    expect(report.erased).toEqual(
      expect.arrayContaining([
        { kind: "memory", id: "m1" },
        { kind: "document", id: "doc1" },
        { kind: "embedding", id: "document:doc1" },
        { kind: "fact", id: "f1" },
      ]),
    );
    expect(report.external).toEqual([{ kind: "external", id: "skill-pr:42" }]);

    expect(db.query("SELECT * FROM memories WHERE id='m1'").get()).toBeNull();
    expect(
      db.query("SELECT * FROM documents WHERE id='doc1'").get(),
    ).toBeNull();
    expect(db.query("SELECT * FROM embeddings").get()).toBeNull();
    expect(db.query("SELECT * FROM facts").get()).toBeNull();
    expect(db.query("SELECT * FROM derivations").get()).toBeNull();

    const ftsHits = db
      .query(
        `SELECT d.id FROM documents_fts f
         JOIN documents d ON d.rowid = f.rowid
         WHERE documents_fts MATCH 'billing'`,
      )
      .all();
    expect(ftsHits).toHaveLength(0);

    expect(onErase).toHaveBeenCalledTimes(1);
    expect(onErase.mock.calls[0]?.[0]).toBe(report);
  });
});
