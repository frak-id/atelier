import { describe, expect, test } from "bun:test";
import { openKnowledgeDb } from "../db.ts";
import type { EntityInput, FactInput } from "../types.ts";
import { membershipResolver } from "../util.ts";
import { SqliteGraphStore } from "./store.ts";

function makeStore(clock?: () => number) {
  const db = openKnowledgeDb(":memory:");
  return { db, store: new SqliteGraphStore(db, { clock }) };
}

const team: EntityInput = {
  id: "team:payments",
  type: "team",
  name: "Payments",
  attrs: {},
  readers: ["org"],
};
const service: EntityInput = {
  id: "service:billing",
  type: "service",
  name: "Billing",
  attrs: {},
  readers: ["org"],
};

describe("SqliteGraphStore.assertFacts", () => {
  test("assert / re-assert / invalidate, with history via asOf", () => {
    let now = 1000;
    const { store } = makeStore(() => now);
    store.upsertEntities([team, service]);

    const owns: FactInput = {
      type: "owns",
      from: "team:payments",
      to: "service:billing",
    };
    const first = store.assertFacts({ key: "memory:m1" }, [owns]);
    expect(first).toEqual({
      source: { key: "memory:m1" },
      added: 1,
      unchanged: 0,
      invalidated: 0,
    });

    now = 2000;
    const second = store.assertFacts({ key: "memory:m1" }, [owns]);
    expect(second.added).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.invalidated).toBe(0);

    now = 3000;
    const third = store.assertFacts({ key: "memory:m1" }, []);
    expect(third.invalidated).toBe(1);

    const currentFacts = store.factsFor("team:payments", {
      audience: ["org"],
    });
    expect(currentFacts).toHaveLength(0);

    const historicalFacts = store.factsFor("team:payments", {
      audience: ["org"],
      asOf: 1500,
    });
    expect(historicalFacts).toHaveLength(1);
    expect(historicalFacts[0]?.type).toBe("owns");

    const fullHistory = store.factsFor("team:payments", {
      audience: ["org"],
      includeHistory: true,
    });
    expect(fullHistory).toHaveLength(1);
    expect(fullHistory[0]?.invalidatedAt).toBe(3000);
  });

  test("dedupes input facts by fingerprint", () => {
    const { store } = makeStore();
    store.upsertEntities([team, service]);
    const owns: FactInput = {
      type: "owns",
      from: "team:payments",
      to: "service:billing",
    };
    const report = store.assertFacts({ key: "memory:m1" }, [owns, { ...owns }]);
    expect(report.added).toBe(1);
  });
});

describe("SqliteGraphStore.retractSource", () => {
  test("soft retract invalidates current facts, keeps history", () => {
    const { store } = makeStore();
    store.upsertEntities([team, service]);
    store.assertFacts({ key: "memory:m1" }, [
      { type: "owns", from: "team:payments", to: "service:billing" },
    ]);
    const count = store.retractSource("memory:m1");
    expect(count).toBe(1);
    expect(store.factsFor("team:payments", { audience: ["org"] })).toHaveLength(
      0,
    );
    expect(
      store.factsFor("team:payments", {
        audience: ["org"],
        includeHistory: true,
      }),
    ).toHaveLength(1);
  });

  test("hard retract deletes all history", () => {
    const { store } = makeStore();
    store.upsertEntities([team, service]);
    store.assertFacts({ key: "memory:m1" }, [
      { type: "owns", from: "team:payments", to: "service:billing" },
    ]);
    const count = store.retractSource("memory:m1", { hard: true });
    expect(count).toBe(1);
    expect(
      store.factsFor("team:payments", {
        audience: ["org"],
        includeHistory: true,
      }),
    ).toHaveLength(0);
  });
});

describe("SqliteGraphStore.neighbors", () => {
  test("respects depth and direction", () => {
    const { store } = makeStore();
    store.upsertEntities([
      team,
      service,
      {
        id: "person:alice",
        type: "person",
        name: "Alice",
        attrs: {},
        readers: ["org"],
      },
    ]);
    store.assertFacts({ key: "s1" }, [
      { type: "owns", from: "team:payments", to: "service:billing" },
      { type: "maintains", from: "person:alice", to: "service:billing" },
    ]);

    const outOnly = store.neighbors({
      entityId: "team:payments",
      direction: "out",
      audience: ["org"],
      depth: 1,
    });
    expect(outOnly.entities.map((e) => e.id)).toEqual(["service:billing"]);

    const inOnly = store.neighbors({
      entityId: "service:billing",
      direction: "in",
      audience: ["org"],
      depth: 1,
    });
    expect(inOnly.entities.map((e) => e.id).sort()).toEqual([
      "person:alice",
      "team:payments",
    ]);

    const depth2 = store.neighbors({
      entityId: "team:payments",
      direction: "both",
      audience: ["org"],
      depth: 2,
    });
    expect(depth2.entities.map((e) => e.id).sort()).toEqual([
      "person:alice",
      "service:billing",
    ]);
  });

  test("ACL: team reader hidden from a user unless membership covers them", () => {
    const db = openKnowledgeDb(":memory:");
    const access = membershipResolver({ "team:a": ["user:bob"] });
    const store = new SqliteGraphStore(db, { access });
    store.upsertEntities([
      { id: "team:a", type: "team", name: "A", attrs: {}, readers: ["org"] },
      {
        id: "service:x",
        type: "service",
        name: "X",
        attrs: {},
        readers: ["org"],
      },
    ]);
    store.assertFacts({ key: "s1" }, [
      {
        type: "owns",
        from: "team:a",
        to: "service:x",
        readers: ["team:a"],
      },
    ]);

    const asBob = store.neighbors({
      entityId: "team:a",
      audience: ["user:bob"],
      direction: "out",
    });
    expect(asBob.facts).toHaveLength(1);

    const asCarol = store.neighbors({
      entityId: "team:a",
      audience: ["user:carol"],
      direction: "out",
    });
    expect(asCarol.facts).toHaveLength(0);
  });

  test("ACL: mixed audience needs every principal covered", () => {
    const db = openKnowledgeDb(":memory:");
    const access = membershipResolver({
      "channel:x": ["user:y"],
      "team:a": ["user:y"],
    });
    const store = new SqliteGraphStore(db, { access });
    store.upsertEntities([
      { id: "team:a", type: "team", name: "A", attrs: {}, readers: ["org"] },
      {
        id: "service:x",
        type: "service",
        name: "X",
        attrs: {},
        readers: ["org"],
      },
    ]);
    store.assertFacts({ key: "s1" }, [
      {
        type: "owns",
        from: "team:a",
        to: "service:x",
        readers: ["channel:x"],
      },
    ]);

    // channel:x covers user:y, but not user:z -> mixed audience fails
    const mixed = store.neighbors({
      entityId: "team:a",
      audience: ["channel:x", "user:z"],
      direction: "out",
    });
    expect(mixed.facts).toHaveLength(0);

    const single = store.neighbors({
      entityId: "team:a",
      audience: ["channel:x"],
      direction: "out",
    });
    expect(single.facts).toHaveLength(1);
  });

  test("retired entities are hidden unless asOf", () => {
    const { store } = makeStore();
    store.upsertEntities([team, service], { sourceKey: "indexer:x" });
    store.assertFacts({ key: "s1" }, [
      { type: "owns", from: "team:payments", to: "service:billing" },
    ]);
    store.retireEntities("indexer:x", ["team:payments"]);

    const now = store.neighbors({
      entityId: "team:payments",
      audience: ["org"],
      direction: "out",
    });
    expect(now.entities).toHaveLength(0);
    expect(now.facts).toHaveLength(1); // fact still returned, entity omitted

    const historical = store.neighbors({
      entityId: "team:payments",
      audience: ["org"],
      direction: "out",
      asOf: Date.now() + 60_000,
    });
    expect(historical.entities.map((e) => e.id)).toEqual(["service:billing"]);
  });

  test("stops traversal at an entity id with no row", () => {
    const { store } = makeStore();
    store.upsertEntities([service]);
    store.assertFacts({ key: "memory:m1" }, [
      { type: "owns", from: "team:ghost", to: "service:billing" },
      { type: "depends_on", from: "service:other", to: "team:ghost" },
    ]);
    const result = store.neighbors({
      entityId: "team:ghost",
      audience: ["org"],
      direction: "both",
      depth: 3,
    });
    // both facts touching the ghost node are visible and returned, but
    // service:billing (which has a row) is the only resolvable entity, and
    // BFS never continues past service:other's absent row.
    expect(result.facts).toHaveLength(2);
    expect(result.entities.map((e) => e.id)).toEqual(["service:billing"]);
  });
});

describe("SqliteGraphStore entities", () => {
  test("upsertEntities un-retires and updates fields", () => {
    const { store } = makeStore();
    store.upsertEntities([team], { sourceKey: "indexer:x" });
    store.retireEntities("indexer:x", []);
    expect(store.getEntity("team:payments")?.retiredAt).toBeDefined();
    store.upsertEntities([{ ...team, name: "Payments Team" }], {
      sourceKey: "indexer:x",
    });
    const updated = store.getEntity("team:payments");
    expect(updated?.retiredAt).toBeUndefined();
    expect(updated?.name).toBe("Payments Team");
  });

  test("listEntities filters by visibility and pages fully", () => {
    const { store } = makeStore();
    const entities: EntityInput[] = Array.from({ length: 20 }, (_, i) => ({
      id: `team:t${i}`,
      type: "team",
      name: `T${i}`,
      attrs: {},
      readers: i % 2 === 0 ? ["org"] : ["team:secret"],
    }));
    store.upsertEntities(entities);
    const visible = store.listEntities({ audience: ["org"], limit: 100 });
    expect(visible).toHaveLength(10);
    expect(visible.every((e) => e.readers.includes("org"))).toBe(true);
  });
});

describe("SqliteGraphStore review findings", () => {
  test("neighbors caps facts on a high fan-out node", () => {
    const { store } = makeStore();
    store.upsertEntities([team]);
    const facts: FactInput[] = Array.from({ length: 100 }, (_, i) => ({
      type: "owns",
      from: "team:payments",
      to: `service:s${i}`,
    }));
    store.assertFacts({ key: "manual" }, facts);
    const sub = store.neighbors({
      entityId: "team:payments",
      audience: ["org"],
      limit: 5,
    });
    expect(sub.facts.length).toBe(20);
  });

  test("retireEntities keeps a set larger than sqlite's bind limit", () => {
    const { store } = makeStore();
    const many: EntityInput[] = Array.from({ length: 40_000 }, (_, i) => ({
      id: `file:r:${i}`,
      type: "file",
      name: `${i}`,
      attrs: {},
      readers: ["org"],
    }));
    store.upsertEntities(many, { sourceKey: "indexer:r" });
    const keep = many.slice(1).map((e) => e.id);
    expect(store.retireEntities("indexer:r", keep)).toBe(1);
  });
});
