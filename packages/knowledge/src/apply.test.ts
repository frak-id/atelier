import { describe, expect, test } from "bun:test";
import { applyIndex } from "./apply.ts";
import { openKnowledgeDb } from "./db.ts";
import { SqliteDocumentStore } from "./documents/store.ts";
import { SqliteGraphStore } from "./graph/store.ts";
import type { RepositoryIndex } from "./types.ts";

function baseIndex(overrides: Partial<RepositoryIndex> = {}): RepositoryIndex {
  return {
    repo: "owner/name",
    revision: "sha1",
    entities: [
      {
        id: "package:@atelier/knowledge",
        type: "package",
        name: "@atelier/knowledge",
        attrs: {},
        readers: ["org"],
      },
      {
        id: "package:@atelier/spec",
        type: "package",
        name: "@atelier/spec",
        attrs: {},
        readers: ["org"],
      },
    ],
    facts: [
      {
        type: "depends_on",
        from: "package:@atelier/knowledge",
        to: "package:@atelier/spec",
      },
    ],
    documents: [
      {
        id: "doc:readme",
        collection: "repo:owner/name",
        title: "README",
        body: "hello",
        entityIds: [],
        readers: ["org"],
        hash: "h1",
      },
    ],
    warnings: [],
    stats: { files: 2, packages: 2, documents: 1, durationMs: 1 },
    ...overrides,
  };
}

describe("applyIndex", () => {
  test("applies entities, facts and documents", () => {
    const db = openKnowledgeDb(":memory:");
    const graph = new SqliteGraphStore(db);
    const documents = new SqliteDocumentStore(db);
    const report = applyIndex(baseIndex(), { graph, documents });
    expect(report.entities.upserted).toBe(2);
    expect(report.entities.retired).toBe(0);
    expect(report.facts.added).toBe(1);
    expect(report.documents.upserted).toBe(1);
    expect(graph.getEntity("package:@atelier/spec")).toBeDefined();
  });

  test("applying twice with a removed package retires it, invalidates its facts, and removes its doc", () => {
    const db = openKnowledgeDb(":memory:");
    const graph = new SqliteGraphStore(db);
    const documents = new SqliteDocumentStore(db);
    applyIndex(baseIndex(), { graph, documents });

    const secondIndex = baseIndex({
      revision: "sha2",
      entities: [
        {
          id: "package:@atelier/knowledge",
          type: "package",
          name: "@atelier/knowledge",
          attrs: {},
          readers: ["org"],
        },
      ],
      facts: [],
      documents: [],
    });
    const report = applyIndex(secondIndex, { graph, documents });

    expect(report.entities.retired).toBe(1);
    const spec = graph.getEntity("package:@atelier/spec");
    expect(spec?.retiredAt).toBeDefined();

    expect(report.facts.invalidated).toBe(1);
    expect(
      graph.factsFor("package:@atelier/knowledge", { audience: ["org"] }),
    ).toHaveLength(0);

    expect(report.documents.removed).toBe(1);
    expect(documents.get("doc:readme")).toBeUndefined();
  });
});
