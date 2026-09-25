import { describe, expect, test } from "bun:test";
import { openKnowledgeDb, SCHEMA_VERSION } from "./db.ts";

describe("openKnowledgeDb", () => {
  test("migrates to the latest schema", () => {
    const db = openKnowledgeDb(":memory:");
    const row = db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    expect(row.user_version).toBe(SCHEMA_VERSION);
  });

  test("FTS mirrors follow inserts, updates and deletes", () => {
    const db = openKnowledgeDb(":memory:");
    const insert = db.query(
      `INSERT INTO documents (id, collection, title, body, hash, updated_at)
       VALUES ($id, 'c', $title, $body, 'h', 0)`,
    );
    insert.run({ id: "d1", title: "Setup", body: "install kubernetes" });
    const hits = () =>
      db
        .query(
          `SELECT d.id FROM documents_fts f
           JOIN documents d ON d.rowid = f.rowid
           WHERE documents_fts MATCH $q`,
        )
        .all({ q: "kubernetes" });
    expect(hits()).toHaveLength(1);
    db.query(
      "UPDATE documents SET body = 'install docker' WHERE id = 'd1'",
    ).run();
    expect(hits()).toHaveLength(0);
    db.query(
      "UPDATE documents SET body = 'kubernetes again' WHERE id = 'd1'",
    ).run();
    expect(hits()).toHaveLength(1);
    db.query("DELETE FROM documents WHERE id = 'd1'").run();
    expect(hits()).toHaveLength(0);
  });
});
