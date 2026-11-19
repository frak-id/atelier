import { describe, expect, test } from "bun:test";
import { parseBumpFile, updateKind } from "./bump-file.ts";

const valid = {
  title: "chore(deps): weekly updates\nsecond line",
  summary: " Biome moved a minor. ",
  updates: [
    {
      name: "@biomejs/biome",
      ecosystem: "npm",
      from: "2.6.4",
      to: "2.7.1",
      changelog: "https://github.com/biomejs/biome/releases/tag/v2.7.1",
      notes: "Migrated biome.json.",
    },
  ],
  held: [
    {
      name: "typescript",
      ecosystem: "npm",
      from: "7.0.2",
      to: "",
      reason: "Too fresh.",
    },
  ],
  checks: [{ command: "bun run test", status: "passed", note: "" }],
};

const parse = (overrides: Record<string, unknown>) =>
  parseBumpFile(JSON.stringify({ ...valid, ...overrides }));

describe("the agent's file", () => {
  test("is read: one line of title, trimmed text, empty optionals left out", () => {
    const file = parse({});
    expect(file.title).toBe("chore(deps): weekly updates");
    expect(file.summary).toBe("Biome moved a minor.");
    expect(file.updates[0]?.changelog).toBe(
      "https://github.com/biomejs/biome/releases/tag/v2.7.1",
    );
    expect(file.held[0]).toEqual({
      name: "typescript",
      ecosystem: "npm",
      from: "7.0.2",
      reason: "Too fresh.",
    });
    expect(file.checks[0]).toEqual({
      command: "bun run test",
      status: "passed",
    });
  });

  test("is refused with what's wrong, for the agent to fix", () => {
    expect(() => parseBumpFile("{")).toThrow("not JSON");
    expect(() => parseBumpFile("[]")).toThrow("not a JSON object");
    expect(() => parse({ summary: " " })).toThrow("`summary`");
    expect(() => parse({ updates: {} })).toThrow("`updates` must be an array");
    expect(() =>
      parse({ updates: [{ ...valid.updates[0], to: undefined }] }),
    ).toThrow("`updates[0].to`");
    expect(() =>
      parse({ updates: [{ ...valid.updates[0], from: "1.0\n2.0" }] }),
    ).toThrow("`updates[0].from` must be one line");
    expect(() =>
      parse({ checks: [{ command: "x", status: "green" }] }),
    ).toThrow("`checks[0].status` must be one of");
    expect(() => parse({ held: [{ name: "x", ecosystem: "npm" }] })).toThrow(
      "`held[0].from`",
    );
  });

  test("takes only an https changelog: it becomes a link", () => {
    for (const changelog of ["javascript:alert(1)", "http://x.y", "not a url"])
      expect(() =>
        parse({ updates: [{ ...valid.updates[0], changelog }] }),
      ).toThrow("`updates[0].changelog` must be an https URL");
  });
});

describe("an update's size", () => {
  test("is read from the versions' numbers, whatever surrounds them", () => {
    expect(updateKind("2.6.4", "2.7.1")).toBe("minor");
    expect(updateKind("^2.6.4", "^2.6.5")).toBe("patch");
    expect(updateKind("v4", "v5")).toBe("major");
    expect(updateKind("26-trixie-slim", "27-trixie-slim")).toBe("major");
    expect(updateKind("1.4", "1.4.4")).toBe("patch");
  });

  test("below 1.0.0, counts the first non-zero number as major", () => {
    expect(updateKind("0.5.1", "0.6.0")).toBe("major");
    expect(updateKind("0.5.1", "0.5.2")).toBe("patch");
    expect(updateKind("0.0.3", "0.0.4")).toBe("major");
  });

  test("is unknown without numbers, or when only a suffix changed", () => {
    expect(updateKind("sha256:abc", "sha256:def")).toBeUndefined();
    expect(updateKind("alpine", "alpine3.21")).toBeUndefined();
    expect(updateKind("1.2.3-alpine", "1.2.3-slim")).toBeUndefined();
  });
});
