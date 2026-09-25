import { describe, expect, test } from "bun:test";
import { openKnowledgeDb } from "../db.ts";
import type { DocumentInput } from "../types.ts";
import { sha256 } from "../util.ts";
import { SqliteDocumentStore } from "./store.ts";

function doc(
  id: string,
  body: string,
  collection = "repo:owner/name",
): DocumentInput {
  return {
    id,
    collection,
    title: id,
    body,
    entityIds: [],
    readers: ["org"],
    hash: sha256(body),
  };
}

describe("SqliteDocumentStore.replaceCollection", () => {
  test("upserts, skips unchanged, removes missing (with embeddings)", () => {
    const db = openKnowledgeDb(":memory:");
    const store = new SqliteDocumentStore(db);

    const first = store.replaceCollection("repo:owner/name", [
      doc("doc:a", "hello world"),
      doc("doc:b", "goodbye world"),
    ]);
    expect(first).toEqual({ upserted: 2, unchanged: 0, removed: 0 });

    db.query(
      `INSERT INTO embeddings
         (owner_kind, owner_id, model, dimensions, vector, content_hash,
          created_at)
       VALUES ('document', 'doc:b', 'm', 1, x'00000000', 'h', 0)`,
    ).run();

    const second = store.replaceCollection("repo:owner/name", [
      doc("doc:a", "hello world"), // unchanged
      doc("doc:c", "new doc"), // new, doc:b removed
    ]);
    expect(second).toEqual({ upserted: 1, unchanged: 1, removed: 1 });

    expect(store.get("doc:b")).toBeUndefined();
    expect(store.get("doc:a")?.body).toBe("hello world");
    expect(store.get("doc:c")?.body).toBe("new doc");

    const embedding = db
      .query(
        "SELECT * FROM embeddings WHERE owner_kind='document' AND owner_id='doc:b'",
      )
      .get();
    expect(embedding).toBeNull();
  });

  test("collections() aggregates count and latest updatedAt", () => {
    const db = openKnowledgeDb(":memory:");
    const store = new SqliteDocumentStore(db);
    store.replaceCollection("repo:a", [doc("doc:a1", "x", "repo:a")]);
    store.replaceCollection("repo:b", [
      doc("doc:b1", "y", "repo:b"),
      doc("doc:b2", "z", "repo:b"),
    ]);
    const collections = store.collections();
    expect(collections.map((c) => c.collection).sort()).toEqual([
      "repo:a",
      "repo:b",
    ]);
    const repoB = collections.find((c) => c.collection === "repo:b");
    expect(repoB?.count).toBe(2);
  });

  test("list() paginates within a collection", () => {
    const db = openKnowledgeDb(":memory:");
    const store = new SqliteDocumentStore(db);
    store.replaceCollection("repo:a", [
      doc("doc:1", "a", "repo:a"),
      doc("doc:2", "b", "repo:a"),
      doc("doc:3", "c", "repo:a"),
    ]);
    expect(store.list("repo:a", { limit: 2 })).toHaveLength(2);
    expect(store.list("repo:a")).toHaveLength(3);
  });
});
