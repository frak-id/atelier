import { describe, expect, mock, test } from "bun:test";
import { openKnowledgeDb } from "../db.ts";
import { Derivations } from "../derivations.ts";
import {
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
} from "../errors.ts";
import type {
  Actor,
  AssertReport,
  FactInput,
  FactSource,
  GraphStore,
} from "../types.ts";
import { MemoryService } from "./service.ts";

const human: Actor = { kind: "human", id: "user:alice" };
const agent: Actor = { kind: "agent", id: "agent:indexer" };

/** Minimal in-memory GraphStore fake; only the two methods memory uses. */
function fakeGraph(): GraphStore & {
  asserted: { source: FactSource; facts: FactInput[] }[];
  retracted: string[];
} {
  const asserted: { source: FactSource; facts: FactInput[] }[] = [];
  const retracted: string[] = [];
  return {
    asserted,
    retracted,
    upsertEntities: () => 0,
    retireEntities: () => 0,
    getEntity: () => undefined,
    listEntities: () => [],
    assertFacts(source, facts): AssertReport {
      asserted.push({ source, facts });
      return { source, added: facts.length, unchanged: 0, invalidated: 0 };
    },
    retractSource(sourceKey) {
      retracted.push(sourceKey);
      return 0;
    },
    factsFor: () => [],
    neighbors: () => ({ entities: [], facts: [] }),
  };
}

describe("MemoryService lifecycle", () => {
  test("propose → approve → active, with audit trail", () => {
    const db = openKnowledgeDb(":memory:");
    const svc = new MemoryService(db);
    const proposed = svc.propose(
      {
        scope: { kind: "team", id: "platform" },
        kind: "ownership",
        content: "team platform owns the deploy pipeline",
      },
      agent,
    );
    expect(proposed.status).toBe("proposed");
    expect(proposed.readers).toEqual(["team:platform"]);

    const active = svc.approve(proposed.id, human, { note: "confirmed" });
    expect(active.status).toBe("active");
    expect(active.reviewedBy).toEqual(human);
    expect(svc.get(proposed.id)?.status).toBe("active");
  });

  test("agent cannot approve or erase", async () => {
    const db = openKnowledgeDb(":memory:");
    const svc = new MemoryService(db);
    const proposed = svc.propose(
      {
        scope: { kind: "org", id: "" },
        kind: "fact",
        content: "the company offsite is in October",
      },
      agent,
    );
    expect(() => svc.approve(proposed.id, agent)).toThrow(ForbiddenError);
    await expect(svc.erase([proposed.id], agent)).rejects.toThrow(
      ForbiddenError,
    );
  });

  test("user preference auto-activates", () => {
    const db = openKnowledgeDb(":memory:");
    const svc = new MemoryService(db);
    const memory = svc.propose(
      {
        scope: { kind: "user", id: "alice" },
        kind: "preference",
        content: "prefers dark mode",
      },
      agent,
    );
    expect(memory.status).toBe("active");
  });

  test("exact duplicate content returns the existing memory", () => {
    const db = openKnowledgeDb(":memory:");
    const svc = new MemoryService(db);
    const first = svc.propose(
      {
        scope: { kind: "team", id: "platform" },
        kind: "fact",
        content: "  Team Platform owns   billing  ",
      },
      agent,
    );
    const second = svc.propose(
      {
        scope: { kind: "team", id: "platform" },
        kind: "fact",
        content: "team platform owns billing",
      },
      agent,
    );
    expect(second.id).toBe(first.id);
    expect(svc.list({ scope: { kind: "team", id: "platform" } })).toHaveLength(
      1,
    );
  });

  test("supersede: approving a replacement archives the original", () => {
    const db = openKnowledgeDb(":memory:");
    const graph = fakeGraph();
    const svc = new MemoryService(db, { graph });
    const original = svc.propose(
      {
        scope: { kind: "team", id: "payments" },
        kind: "ownership",
        content: "team payments owns billing v1",
      },
      human,
    );
    svc.approve(original.id, human);

    const replacement = svc.propose(
      {
        scope: { kind: "team", id: "payments" },
        kind: "ownership",
        content: "team payments owns billing v2",
        supersedes: original.id,
      },
      human,
    );
    const active = svc.approve(replacement.id, human);
    expect(active.status).toBe("active");

    const archived = svc.get(original.id);
    expect(archived?.status).toBe("archived");
    expect(archived?.supersededBy).toBe(replacement.id);
    expect(archived?.validTo).toBeDefined();
    expect(graph.retracted).toContain(`memory:${original.id}`);
  });

  test("bulk archive by tag and date only moves active/stale/proposed", () => {
    const db = openKnowledgeDb(":memory:");
    const svc = new MemoryService(db, { clock: () => 1000 });
    const older = svc.propose(
      {
        scope: { kind: "org", id: "" },
        kind: "convention",
        content: "billing v1 uses REST",
        tags: ["billing-v1"],
      },
      human,
    );
    svc.approve(older.id, human);

    const svcLater = new MemoryService(db, { clock: () => 5000 });
    const newer = svcLater.propose(
      {
        scope: { kind: "org", id: "" },
        kind: "convention",
        content: "billing v1 uses GraphQL",
        tags: ["billing-v1"],
      },
      human,
    );
    svcLater.approve(newer.id, human);

    const rejected = svc.propose(
      {
        scope: { kind: "org", id: "" },
        kind: "convention",
        content: "unrelated tag",
        tags: ["other"],
      },
      human,
    );
    svc.reject(rejected.id, human);

    const count = svc.archiveWhere(
      { tags: ["billing-v1"], createdBefore: 3000 },
      human,
      "context switch",
    );
    expect(count).toBe(1);
    expect(svc.get(older.id)?.status).toBe("archived");
    expect(svc.get(newer.id)?.status).toBe("active");
    expect(svc.get(rejected.id)?.status).toBe("rejected");
  });

  test("erase cascades to derived records, facts and audit stays content-free", async () => {
    const db = openKnowledgeDb(":memory:");
    const derivations = new Derivations(db);
    const graph = fakeGraph();
    const hookReports: unknown[] = [];
    const hooks = [
      {
        onErase: mock((report: unknown) => {
          hookReports.push(report);
        }),
      },
    ];
    const svc = new MemoryService(db, { graph, hooks });

    const memory = svc.propose(
      {
        scope: { kind: "team", id: "payments" },
        kind: "ownership",
        content: "team payments owns billing",
        facts: [{ type: "owns", from: "team:payments", to: "service:billing" }],
      },
      human,
    );
    svc.approve(memory.id, human);

    // a derived document + embedding, as another lane would produce them
    db.query(
      `INSERT INTO documents (id, collection, title, body, hash, updated_at)
       VALUES ('doc1', 'c', 'Billing', 'team payments owns billing', 'h', 0)`,
    ).run();
    db.query(
      `INSERT INTO embeddings
         (owner_kind, owner_id, model, dimensions, vector, content_hash,
          created_at)
       VALUES ('document', 'doc1', 'test', 1, x'00', 'h', 0)`,
    ).run();
    derivations.link(
      { kind: "memory", id: memory.id },
      { kind: "document", id: "doc1" },
    );
    derivations.link(
      { kind: "memory", id: memory.id },
      { kind: "external", id: "skill-pr:9" },
    );
    // The real GraphStore would have written this fact row when the
    // memory activated (`syncGraphActive`); the fake used here only
    // records the call, so insert it directly to exercise erasure's
    // memory-sourced fact cleanup.
    db.query(
      `INSERT INTO facts
         (id, type, from_id, to_id, fingerprint, source_key, readers,
          valid_from, recorded_at)
       VALUES ('f1', 'owns', 'team:payments', 'service:billing', 'fp',
       $sourceKey, '[]', 0, 0)`,
    ).run({ sourceKey: `memory:${memory.id}` });

    // sanity: the memory-sourced fact and FTS row exist before erase
    expect(
      db
        .query("SELECT COUNT(*) as n FROM facts WHERE source_key = $k")
        .get({ k: `memory:${memory.id}` }),
    ).toEqual({ n: 1 });

    const report = await svc.erase([memory.id], human, "user requested");

    expect(report.erased).toEqual(
      expect.arrayContaining([
        { kind: "memory", id: memory.id },
        { kind: "document", id: "doc1" },
        { kind: "embedding", id: "document:doc1" },
      ]),
    );
    expect(report.erased.filter((r) => r.kind === "fact")).toHaveLength(1);
    expect(report.external).toEqual([{ kind: "external", id: "skill-pr:9" }]);

    expect(svc.get(memory.id)).toBeUndefined();
    expect(
      db
        .query("SELECT COUNT(*) as n FROM facts WHERE source_key = $k")
        .get({ k: `memory:${memory.id}` }),
    ).toEqual({ n: 0 });
    const ftsHits = db
      .query(
        `SELECT rowid FROM documents_fts WHERE documents_fts MATCH 'billing'`,
      )
      .all();
    expect(ftsHits).toHaveLength(0);

    expect(hooks[0]?.onErase).toHaveBeenCalledTimes(1);
    expect(hookReports).toHaveLength(1);

    const auditEntries = db
      .query("SELECT detail FROM audit WHERE action = 'memory.erase'")
      .all() as { detail: string }[];
    expect(auditEntries).toHaveLength(1);
    const detail = JSON.parse(auditEntries[0]?.detail ?? "{}");
    expect(detail.reason).toBe("user requested");
    expect(detail.cascade).toBeDefined();
    expect(JSON.stringify(detail)).not.toContain("team payments owns");
  });

  test("recordUse increments use_count and last_used_at", () => {
    const db = openKnowledgeDb(":memory:");
    const svc = new MemoryService(db, { clock: () => 42 });
    const memory = svc.propose(
      {
        scope: { kind: "org", id: "" },
        kind: "fact",
        content: "some fact worth remembering",
      },
      human,
    );
    svc.approve(memory.id, human);
    svc.recordUse([memory.id, "missing-id"], agent);
    const used = svc.get(memory.id);
    expect(used?.useCount).toBe(1);
    expect(used?.lastUsedAt).toBe(42);
  });

  test("flag moves active to stale and retracts graph facts", () => {
    const db = openKnowledgeDb(":memory:");
    const graph = fakeGraph();
    const svc = new MemoryService(db, { graph });
    const memory = svc.propose(
      {
        scope: { kind: "org", id: "" },
        kind: "fact",
        content: "some claim",
      },
      human,
    );
    svc.approve(memory.id, human);
    const flagged = svc.flag(memory.id, agent, "that's wrong");
    expect(flagged.status).toBe("stale");
    expect(graph.retracted).toContain(`memory:${memory.id}`);
    expect(() => svc.flag(memory.id, agent, "again")).toThrow(
      InvalidTransitionError,
    );
  });

  test("get/approve on missing id throws NotFoundError", () => {
    const db = openKnowledgeDb(":memory:");
    const svc = new MemoryService(db);
    expect(() => svc.approve("nope", human)).toThrow(NotFoundError);
  });
});
