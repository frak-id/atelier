import { describe, expect, test } from "bun:test";
import { openKnowledgeDb } from "./db.ts";
import { Derivations } from "./derivations.ts";
import type { RecordRef } from "./types.ts";

const mem = (id: string): RecordRef => ({ kind: "memory", id });
const doc = (id: string): RecordRef => ({ kind: "document", id });
const emb = (id: string): RecordRef => ({ kind: "embedding", id });

describe("Derivations", () => {
  test("link is idempotent", () => {
    const db = openKnowledgeDb(":memory:");
    const d = new Derivations(db);
    d.link(mem("m1"), doc("d1"));
    d.link(mem("m1"), doc("d1"));
    const count = db.query("SELECT COUNT(*) as n FROM derivations").get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });

  test("children and parents", () => {
    const db = openKnowledgeDb(":memory:");
    const d = new Derivations(db);
    d.link(mem("m1"), doc("d1"));
    d.link(mem("m1"), doc("d2"));
    expect(d.children(mem("m1"))).toEqual(
      expect.arrayContaining([doc("d1"), doc("d2")]),
    );
    expect(d.parents(doc("d1"))).toEqual([mem("m1")]);
  });

  test("descendants is transitive and cycle-safe", () => {
    const db = openKnowledgeDb(":memory:");
    const d = new Derivations(db);
    d.link(mem("m1"), doc("d1"));
    d.link(doc("d1"), emb("document:d1"));
    // introduce a cycle back to the root
    d.link(emb("document:d1"), mem("m1"));

    const result = d.descendants(mem("m1"));
    expect(result).toEqual(
      expect.arrayContaining([doc("d1"), emb("document:d1")]),
    );
    expect(result).toHaveLength(2);
  });

  test("removeAll drops rows where ref is either side", () => {
    const db = openKnowledgeDb(":memory:");
    const d = new Derivations(db);
    d.link(mem("m1"), doc("d1"));
    d.link(doc("d1"), emb("document:d1"));
    d.removeAll(doc("d1"));
    expect(d.children(mem("m1"))).toEqual([]);
    expect(d.children(doc("d1"))).toEqual([]);
  });
});
