import { describe, expect, test } from "bun:test";
import { composePi, piIsNotice, piStartupNotice } from "./pi.ts";

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

describe("pi-acp notices", () => {
  test("the startup banner comes from session/new's _meta", () => {
    const banner = "pi v1.2.0\n---\n\n## Extensions\n- npm:pi-context\n";
    expect(piStartupNotice({ piAcp: { startupInfo: banner } })).toBe(banner);
    expect(piStartupNotice({ piAcp: { startupInfo: null } })).toBeUndefined();
    expect(piStartupNotice({ piAcp: { startupInfo: "" } })).toBeUndefined();
    expect(piStartupNotice(undefined)).toBeUndefined();
  });

  test("extension notices are the chunks tagged piAcp.notify", () => {
    expect(piIsNotice({ piAcp: { notify: { level: "info" } } })).toBe(true);
    expect(piIsNotice({ piAcp: { queueDepth: 0, running: true } })).toBe(false);
    expect(piIsNotice({ other: { notify: true } })).toBe(false);
    expect(piIsNotice(null)).toBe(false);
  });
});
