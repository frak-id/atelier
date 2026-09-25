import { describe, expect, test } from "bun:test";
import { openKnowledgeDb } from "../db.ts";
import { SqliteDocumentStore } from "../documents/store.ts";
import { ValidationError } from "../errors.ts";
import { SqliteGraphStore } from "../graph/store.ts";
import { HashingEmbedder } from "./embedders.ts";
import { buildFtsQuery, KnowledgeSearch } from "./search.ts";

function seedMemory(
  db: ReturnType<typeof openKnowledgeDb>,
  overrides: Partial<{
    id: string;
    content: string;
    status: string;
    readers: string[];
  }> = {},
) {
  const id = overrides.id ?? "mem:1";
  db.query(
    `INSERT INTO memories
       (id, scope_kind, scope_id, kind, content, tags, status, readers,
        entity_ids, facts, provenance, created_by, valid_from, use_count,
        created_at, updated_at)
     VALUES
       ($id, 'org', '', 'fact', $content, '[]', $status, $readers,
        '[]', '[]', '[]', '{"kind":"human","id":"user:a"}', 0, 0, 0, 0)`,
  ).run({
    id,
    content: overrides.content ?? "Kubernetes runs the Atelier control plane",
    status: overrides.status ?? "active",
    readers: JSON.stringify(overrides.readers ?? ["org"]),
  });
}

describe("buildFtsQuery", () => {
  test("never throws on hostile input", () => {
    for (const text of ['foo" OR (bar', "*", "NEAR(", "", "  ", "col:val"]) {
      expect(() => buildFtsQuery(text)).not.toThrow();
    }
  });

  test("empty/whitespace-only text yields no query", () => {
    expect(buildFtsQuery("")).toBeUndefined();
    expect(buildFtsQuery("   ")).toBeUndefined();
    expect(buildFtsQuery("*")).toBeUndefined();
  });

  test("quotes tokens and prefixes the last one", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" OR "world"*');
  });
});

describe("KnowledgeSearch.search", () => {
  test("rejects an empty audience", async () => {
    const db = openKnowledgeDb(":memory:");
    const search = new KnowledgeSearch(db);
    await expect(
      search.search({ text: "x", audience: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("FTS ranks better matches first", async () => {
    const db = openKnowledgeDb(":memory:");
    seedMemory(db, {
      id: "mem:1",
      content: "kubernetes kubernetes kubernetes cluster setup",
    });
    seedMemory(db, {
      id: "mem:2",
      content: "kubernetes is mentioned once here",
    });
    const search = new KnowledgeSearch(db);
    const hits = await search.search({
      text: "kubernetes",
      audience: ["org"],
      kinds: ["memory"],
    });
    expect(hits[0]?.id).toBe("mem:1");
    expect(hits.every((h) => h.matchedBy.includes("fts"))).toBe(true);
  });

  test("ACL-filters hits the audience can't read", async () => {
    const db = openKnowledgeDb(":memory:");
    seedMemory(db, {
      id: "mem:secret",
      content: "kubernetes secret rotation runbook",
      readers: ["team:secret"],
    });
    const search = new KnowledgeSearch(db);
    const asOrg = await search.search({
      text: "kubernetes",
      audience: ["org"],
      kinds: ["memory"],
    });
    expect(asOrg.map((h) => h.id)).not.toContain("mem:secret");
  });

  test("defaults to active memories only", async () => {
    const db = openKnowledgeDb(":memory:");
    seedMemory(db, { id: "mem:proposed", status: "proposed" });
    seedMemory(db, { id: "mem:active", status: "active" });
    const search = new KnowledgeSearch(db);
    const hits = await search.search({
      text: "kubernetes",
      audience: ["org"],
      kinds: ["memory"],
    });
    expect(hits.map((h) => h.id)).toEqual(["mem:active"]);

    const includingProposed = await search.search({
      text: "kubernetes",
      audience: ["org"],
      kinds: ["memory"],
      memoryStatus: ["active", "proposed"],
    });
    expect(includingProposed.map((h) => h.id).sort()).toEqual([
      "mem:active",
      "mem:proposed",
    ]);
  });

  test("hybrid search records matchedBy per retriever", async () => {
    const db = openKnowledgeDb(":memory:");
    seedMemory(db, { id: "mem:1", content: "atelier sandbox orchestration" });
    const embedder = new HashingEmbedder(32);
    const search = new KnowledgeSearch(db, { embedder });
    await search.embedPending({ kinds: ["memory"] });
    const hits = await search.search({
      text: "atelier sandbox",
      audience: ["org"],
      kinds: ["memory"],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.matchedBy).toContain("fts");
    expect(hits[0]?.matchedBy).toContain("vector");
  });

  test("entity and document hits carry titles/urls", async () => {
    const db = openKnowledgeDb(":memory:");
    const graph = new SqliteGraphStore(db);
    graph.upsertEntities([
      {
        id: "package:@atelier/spec",
        type: "package",
        name: "@atelier/spec",
        summary: "The SandboxSpec contract",
        attrs: {},
        readers: ["org"],
      },
    ]);
    const documents = new SqliteDocumentStore(db);
    documents.replaceCollection("repo:owner/name", [
      {
        id: "doc:readme",
        collection: "repo:owner/name",
        title: "README",
        body: "Explains the sandbox spec contract in detail",
        url: "https://example.com/readme",
        entityIds: [],
        readers: ["org"],
        hash: "h1",
      },
    ]);
    const search = new KnowledgeSearch(db);
    const entityHits = await search.search({
      text: "spec contract",
      audience: ["org"],
      kinds: ["entity"],
    });
    expect(entityHits[0]?.title).toBe("@atelier/spec (package)");

    const docHits = await search.search({
      text: "spec contract",
      audience: ["org"],
      kinds: ["document"],
    });
    expect(docHits[0]?.url).toBe("https://example.com/readme");
  });
});

describe("KnowledgeSearch.embedPending", () => {
  test("is idempotent and re-embeds on content change", async () => {
    const db = openKnowledgeDb(":memory:");
    seedMemory(db, { id: "mem:1", content: "original content here" });
    const embedder = new HashingEmbedder(16);
    const search = new KnowledgeSearch(db, { embedder });

    const first = await search.embedPending({ kinds: ["memory"] });
    expect(first).toEqual({ embedded: 1, skipped: 0 });

    const second = await search.embedPending({ kinds: ["memory"] });
    expect(second).toEqual({ embedded: 0, skipped: 1 });

    db.query("UPDATE memories SET content = $c WHERE id = 'mem:1'").run({
      c: "changed content here",
    });
    const third = await search.embedPending({ kinds: ["memory"] });
    expect(third).toEqual({ embedded: 1, skipped: 0 });
  });

  test("is a no-op without an embedder (FTS-only deployments)", async () => {
    const db = openKnowledgeDb(":memory:");
    const search = new KnowledgeSearch(db);
    expect(await search.embedPending()).toEqual({ embedded: 0, skipped: 0 });
  });
});
