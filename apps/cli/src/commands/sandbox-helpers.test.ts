import { describe, expect, test } from "bun:test";
import { idleOf, parseDuration } from "./sandbox-helpers.ts";

describe("parseDuration", () => {
  test("minutes, hours, days, decimals", () => {
    expect(parseDuration("90m")).toBe(90 * 60_000);
    expect(parseDuration("8h")).toBe(8 * 3_600_000);
    expect(parseDuration("1.5h")).toBe(90 * 60_000);
    expect(parseDuration(" 2d ")).toBe(2 * 86_400_000);
  });

  test("anything else is refused", () => {
    for (const text of ["", "8", "0h", "-1h", "8 hours", "1w"]) {
      expect(parseDuration(text)).toBeUndefined();
    }
  });
});

describe("idleOf", () => {
  test("shows the deadline of an active sandbox", () => {
    const pausesAt = new Date(Date.now() + 100 * 60_000).toISOString();
    expect(
      idleOf({ mode: "enforce", state: "active", lastActiveAt: "", pausesAt }),
    ).toBe("pauses in 1h40m");
    // Observe mode: only what would happen (dimmed).
    expect(
      idleOf({ mode: "observe", state: "active", lastActiveAt: "", pausesAt }),
    ).toContain("would pause in 1h40m");
  });

  test("no idle state is a dash", () => {
    expect(idleOf(undefined)).toBe("-");
    expect(idleOf({ mode: "observe", state: "off" })).toBe("-");
  });
});
