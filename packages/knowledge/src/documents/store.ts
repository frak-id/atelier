/**
 * Document collections: chunked text rebuilt wholesale from a source (repo
 * docs, a generated wiki). `replaceCollection` is the only write path —
 * documents are never hand-edited, only re-indexed.
 */
import type { Database } from "bun:sqlite";
import type { Document, DocumentInput, DocumentStore } from "../types.ts";
import { opt, parseJson } from "../util.ts";

interface DocumentRow {
  id: string;
  collection: string;
  title: string;
  body: string;
  path: string | null;
  url: string | null;
  revision: string | null;
  entity_ids: string;
  readers: string;
  hash: string;
  updated_at: number;
}

function mapDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    collection: row.collection,
    title: row.title,
    body: row.body,
    path: opt(row.path),
    url: opt(row.url),
    revision: opt(row.revision),
    entityIds: parseJson(row.entity_ids, []),
    readers: parseJson(row.readers, []),
    hash: row.hash,
    updatedAt: row.updated_at,
  };
}

export class SqliteDocumentStore implements DocumentStore {
  constructor(private readonly db: Database) {}

  replaceCollection(
    collection: string,
    docs: DocumentInput[],
  ): { upserted: number; unchanged: number; removed: number } {
    const now = Date.now();
    const existingRows = this.db
      .query("SELECT id, hash FROM documents WHERE collection = $collection")
      .all({ collection }) as { id: string; hash: string }[];
    const existingHash = new Map(existingRows.map((r) => [r.id, r.hash]));

    const upsert = this.db.query(
      `INSERT INTO documents
         (id, collection, title, body, path, url, revision, entity_ids,
          readers, hash, updated_at)
       VALUES
         ($id, $collection, $title, $body, $path, $url, $revision,
          $entityIds, $readers, $hash, $now)
       ON CONFLICT(id) DO UPDATE SET
         collection = excluded.collection,
         title = excluded.title,
         body = excluded.body,
         path = excluded.path,
         url = excluded.url,
         revision = excluded.revision,
         entity_ids = excluded.entity_ids,
         readers = excluded.readers,
         hash = excluded.hash,
         updated_at = $now`,
    );
    const deleteDoc = this.db.query("DELETE FROM documents WHERE id = $id");
    const deleteEmbedding = this.db.query(
      `DELETE FROM embeddings
       WHERE owner_kind = 'document' AND owner_id = $id`,
    );

    let upserted = 0;
    let unchanged = 0;
    let removed = 0;
    const keepIds = new Set<string>();

    this.db.transaction(() => {
      for (const doc of docs) {
        keepIds.add(doc.id);
        if (existingHash.get(doc.id) === doc.hash) {
          unchanged++;
          continue;
        }
        upsert.run({
          id: doc.id,
          collection: doc.collection,
          title: doc.title,
          body: doc.body,
          path: doc.path ?? null,
          url: doc.url ?? null,
          revision: doc.revision ?? null,
          entityIds: JSON.stringify(doc.entityIds),
          readers: JSON.stringify(doc.readers),
          hash: doc.hash,
          now,
        });
        upserted++;
      }
      for (const id of existingHash.keys()) {
        if (keepIds.has(id)) continue;
        deleteDoc.run({ id });
        deleteEmbedding.run({ id });
        removed++;
      }
    })();

    return { upserted, unchanged, removed };
  }

  get(id: string): Document | undefined {
    const row = this.db
      .query("SELECT * FROM documents WHERE id = $id")
      .get({ id }) as DocumentRow | null;
    return row ? mapDocument(row) : undefined;
  }

  list(
    collection: string,
    opts: { limit?: number; offset?: number } = {},
  ): Document[] {
    const rows = this.db
      .query(
        `SELECT * FROM documents WHERE collection = $collection
         ORDER BY id
         LIMIT $limit OFFSET $offset`,
      )
      .all({
        collection,
        limit: opts.limit ?? 200,
        offset: opts.offset ?? 0,
      }) as DocumentRow[];
    return rows.map(mapDocument);
  }

  collections(): { collection: string; count: number; updatedAt: number }[] {
    const rows = this.db
      .query(
        `SELECT collection, COUNT(*) AS count, MAX(updated_at) AS updated_at
         FROM documents
         GROUP BY collection
         ORDER BY collection`,
      )
      .all() as { collection: string; count: number; updated_at: number }[];
    return rows.map((r) => ({
      collection: r.collection,
      count: r.count,
      updatedAt: r.updated_at,
    }));
  }
}
