import { describe, expect, test } from "bun:test";
import { composePi } from "./pi.ts";

describe("composePi", () => {
  test("acp PATH resolves pi from the managed install, then ~/.local", () => {
    const acp = composePi().processes?.find((p) => p.name === "acp");
    const envPath = acp?.env?.PATH;
    const path = typeof envPath === "string" ? envPath.split(":") : [];
    // pi-acp spawns a bare `pi`; the managed launcher must win over a stale
    // npm global install.
    expect(path.slice(0, 2)).toEqual([
      "/home/dev/.pi/agent/bin",
      "/home/dev/.local/bin",
    ]);
  });
});
