import { describe, expect, test } from "bun:test";
import { canonicalJson } from "./canonical-json.ts";

describe("canonicalJson", () => {
  test("key order never matters, at any depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [2, 1] }, b: 1 }),
    );
    expect(canonicalJson([{ y: 1, x: 2 }])).toBe(
      canonicalJson([{ x: 2, y: 1 }]),
    );
  });

  test("array order does, and undefined keys drop like JSON", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});
