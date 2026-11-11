import { describe, expect, test } from "bun:test";
import { isServiceOwned, ownerFromAnnotations } from "./sandbox-status.ts";

describe("isServiceOwned", () => {
  test("true only for the service owner kind", () => {
    expect(isServiceOwned({ "atelier.dev/owner-kind": "service" })).toBe(true);
    expect(isServiceOwned({ "atelier.dev/owner-kind": "human" })).toBe(false);
    expect(isServiceOwned({ "atelier.dev/owner": "bot[bot]" })).toBe(false);
    expect(isServiceOwned(undefined)).toBe(false);
  });
});

describe("ownerFromAnnotations", () => {
  test("reads the owner annotation", () => {
    expect(ownerFromAnnotations({ "atelier.dev/owner": "me" })).toBe("me");
  });
});
