import { describe, expect, test } from "bun:test";
import { composePi } from "./pi.ts";

describe("composePi", () => {
  test("acp command puts pi's bin dirs on PATH, managed install first", () => {
    const acp = composePi().processes?.find((p) => p.name === "acp");
    // The supervisor runs commands under `bash -l -c`, whose /etc/profile
    // resets PATH, so the prefix must live in the command, not in `env`.
    expect(acp?.env?.PATH).toBeUndefined();
    const match = acp?.command.match(/^PATH="([^"]+)" exec (\S+)$/);
    expect(match?.[2]).toBe("/home/dev/.local/bin/pi-acp");
    // pi-acp spawns a bare `pi`; the managed launcher must win over a stale
    // npm global install, and the login shell's PATH must stay reachable.
    expect(match?.[1]?.split(":")).toEqual([
      "/home/dev/.pi/agent/bin",
      "/home/dev/.local/bin",
      "$PATH",
    ]);
  });
});
