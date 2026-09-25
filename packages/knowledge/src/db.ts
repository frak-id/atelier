/**
 * The knowledge store: one sqlite file (bun:sqlite), schema versioned with
 * `PRAGMA user_version`. Raw SQL rather than drizzle because the store
 * leans on FTS5 external-content tables and triggers, which drizzle does
 * not model.
 *
 * Conventions: JSON columns are TEXT holding `JSON.stringify` output
 * (decoded with `util.ts#parseJson`); times are epoch ms INTEGERs; nullable
 * columns map to optional fields. Every table with an FTS mirror keeps it in
 * sync through triggers, so writers only touch the base table.
 */
import { Database } from "bun:sqlite";

export type KnowledgeDb = Database;

/** Append-only. Never edit a shipped migration; add a new one. */
const MIGRATIONS: string[] = [
  /* 1 — initial schema */ `
  CREATE TABLE memories (
    id            TEXT PRIMARY KEY,
    scope_kind    TEXT NOT NULL,
    scope_id      TEXT NOT NULL DEFAULT '',
    kind          TEXT NOT NULL,
    content       TEXT NOT NULL,
    tags          TEXT NOT NULL DEFAULT '[]',
    status        TEXT NOT NULL,
    readers       TEXT NOT NULL DEFAULT '[]',
    entity_ids    TEXT NOT NULL DEFAULT '[]',
    facts         TEXT NOT NULL DEFAULT '[]',
    provenance    TEXT NOT NULL DEFAULT '[]',
    created_by    TEXT NOT NULL,
    reviewed_by   TEXT,
    review_note   TEXT,
    valid_from    INTEGER NOT NULL,
    valid_to      INTEGER,
    supersedes    TEXT,
    superseded_by TEXT,
    use_count     INTEGER NOT NULL DEFAULT 0,
    last_used_at  INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX memories_status ON memories(status);
  CREATE INDEX memories_scope ON memories(scope_kind, scope_id);
  CREATE INDEX memories_supersedes ON memories(supersedes);

  CREATE VIRTUAL TABLE memories_fts USING fts5(
    content, tags,
    content='memories', content_rowid='rowid',
    tokenize='porter unicode61'
  );
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, tags)
    VALUES (new.rowid, new.content, new.tags);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags)
    VALUES ('delete', old.rowid, old.content, old.tags);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE OF content, tags ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags)
    VALUES ('delete', old.rowid, old.content, old.tags);
    INSERT INTO memories_fts(rowid, content, tags)
    VALUES (new.rowid, new.content, new.tags);
  END;

  CREATE TABLE entities (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    name        TEXT NOT NULL,
    summary     TEXT,
    attrs       TEXT NOT NULL DEFAULT '{}',
    readers     TEXT NOT NULL DEFAULT '[]',
    source_key  TEXT,
    retired_at  INTEGER,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX entities_type ON entities(type);
  CREATE INDEX entities_source ON entities(source_key);

  CREATE VIRTUAL TABLE entities_fts USING fts5(
    id, name, summary,
    content='entities', content_rowid='rowid',
    tokenize='porter unicode61'
  );
  CREATE TRIGGER entities_ai AFTER INSERT ON entities BEGIN
    INSERT INTO entities_fts(rowid, id, name, summary)
    VALUES (new.rowid, new.id, new.name, coalesce(new.summary, ''));
  END;
  CREATE TRIGGER entities_ad AFTER DELETE ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, id, name, summary)
    VALUES ('delete', old.rowid, old.id, old.name, coalesce(old.summary, ''));
  END;
  CREATE TRIGGER entities_au AFTER UPDATE OF name, summary ON entities BEGIN
    INSERT INTO entities_fts(entities_fts, rowid, id, name, summary)
    VALUES ('delete', old.rowid, old.id, old.name, coalesce(old.summary, ''));
    INSERT INTO entities_fts(rowid, id, name, summary)
    VALUES (new.rowid, new.id, new.name, coalesce(new.summary, ''));
  END;

  CREATE TABLE facts (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,
    from_id         TEXT NOT NULL,
    to_id           TEXT NOT NULL,
    attrs           TEXT NOT NULL DEFAULT '{}',
    fingerprint     TEXT NOT NULL,
    source_key      TEXT NOT NULL,
    source_revision TEXT,
    readers         TEXT NOT NULL DEFAULT '[]',
    valid_from      INTEGER NOT NULL,
    valid_to        INTEGER,
    recorded_at     INTEGER NOT NULL,
    invalidated_at  INTEGER
  );
  CREATE INDEX facts_from ON facts(from_id, type);
  CREATE INDEX facts_to ON facts(to_id, type);
  CREATE INDEX facts_source ON facts(source_key, fingerprint);

  CREATE TABLE documents (
    id          TEXT PRIMARY KEY,
    collection  TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    path        TEXT,
    url         TEXT,
    revision    TEXT,
    entity_ids  TEXT NOT NULL DEFAULT '[]',
    readers     TEXT NOT NULL DEFAULT '[]',
    hash        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX documents_collection ON documents(collection);

  CREATE VIRTUAL TABLE documents_fts USING fts5(
    title, body,
    content='documents', content_rowid='rowid',
    tokenize='porter unicode61'
  );
  CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, title, body)
    VALUES (new.rowid, new.title, new.body);
  END;
  CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, body)
    VALUES ('delete', old.rowid, old.title, old.body);
  END;
  CREATE TRIGGER documents_au AFTER UPDATE OF title, body ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, body)
    VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO documents_fts(rowid, title, body)
    VALUES (new.rowid, new.title, new.body);
  END;

  -- One vector per (record, model). content_hash says which text was
  -- embedded, so an edit re-embeds and an unchanged record is skipped.
  CREATE TABLE embeddings (
    owner_kind    TEXT NOT NULL,
    owner_id      TEXT NOT NULL,
    model         TEXT NOT NULL,
    dimensions    INTEGER NOT NULL,
    vector        BLOB NOT NULL,
    content_hash  TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    PRIMARY KEY (owner_kind, owner_id, model)
  );

  CREATE TABLE derivations (
    parent_kind TEXT NOT NULL,
    parent_id   TEXT NOT NULL,
    child_kind  TEXT NOT NULL,
    child_id    TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (parent_kind, parent_id, child_kind, child_id)
  );
  CREATE INDEX derivations_child ON derivations(child_kind, child_id);

  CREATE TABLE audit (
    id          TEXT PRIMARY KEY,
    at          INTEGER NOT NULL,
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id   TEXT NOT NULL,
    detail      TEXT
  );
  CREATE INDEX audit_target ON audit(target_kind, target_id);
  CREATE INDEX audit_at ON audit(at);
  `,
];

/** Latest schema version this build knows. */
export const SCHEMA_VERSION = MIGRATIONS.length;

function migrate(db: Database): void {
  const row = db.query("PRAGMA user_version").get() as {
    user_version: number;
  };
  const current = row.user_version;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `knowledge db is at schema v${current}, newer than this build ` +
        `(v${SCHEMA_VERSION})`,
    );
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    const sql = MIGRATIONS[v];
    if (sql === undefined) break;
    db.transaction(() => {
      db.run(sql);
      db.run(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}

/**
 * Opens (creating if needed) and migrates a knowledge DB. Pass `":memory:"`
 * for tests.
 */
export function openKnowledgeDb(path: string): KnowledgeDb {
  const db = new Database(path, { create: true, strict: true });
  if (path !== ":memory:") db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}
