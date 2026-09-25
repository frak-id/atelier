import { describe, expect, test } from "bun:test";
import { AuditLog } from "./audit.ts";
import { openKnowledgeDb } from "./db.ts";

describe("AuditLog", () => {
  test("append records an entry and list returns newest first", () => {
    const db = openKnowledgeDb(":memory:");
    const log = new AuditLog(db);
    const actor = { kind: "human" as const, id: "user:alice" };

    log.append(actor, "memory.propose", { kind: "memory", id: "m1" });
    log.append(
      actor,
      "memory.approve",
      { kind: "memory", id: "m1" },
      { note: "looks right" },
    );

    const entries = log.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.action).toBe("memory.approve");
    expect(entries[0]?.detail).toEqual({ note: "looks right" });
    expect(entries[1]?.action).toBe("memory.propose");
    expect(entries[1]?.detail).toBeUndefined();
  });

  test("list filters by target and action", () => {
    const db = openKnowledgeDb(":memory:");
    const log = new AuditLog(db);
    const actor = { kind: "human" as const, id: "user:alice" };

    log.append(actor, "memory.propose", { kind: "memory", id: "m1" });
    log.append(actor, "memory.propose", { kind: "memory", id: "m2" });
    log.append(actor, "memory.approve", { kind: "memory", id: "m1" });

    expect(log.list({ target: { kind: "memory", id: "m2" } })).toHaveLength(1);
    expect(log.list({ action: "memory.approve" })).toHaveLength(1);
    expect(log.list({ since: 0 })).toHaveLength(3);
    expect(log.list({ since: Date.now() + 60_000 })).toHaveLength(0);
  });

  test("never stores memory content in detail", () => {
    const db = openKnowledgeDb(":memory:");
    const log = new AuditLog(db);
    const actor = { kind: "human" as const, id: "user:alice" };
    log.append(
      actor,
      "memory.erase",
      { kind: "memory", id: "m1" },
      { reason: "user requested", cascade: { document: 1 } },
    );
    const raw = db.query("SELECT detail FROM audit").get() as {
      detail: string;
    };
    expect(raw.detail).not.toContain("content");
    expect(JSON.parse(raw.detail)).toEqual({
      reason: "user requested",
      cascade: { document: 1 },
    });
  });
});
