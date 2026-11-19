import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ALLOWED,
  findingLimits,
  improvementCategories,
  parseAllowedFindings,
  REFERENCE_LINES,
  scaled,
} from "./limits.ts";

const first = (lines: number) => ({ lines, later: false });
const later = (lines: number, improvementsSince: number) => ({
  lines,
  later: true,
  improvementsSince,
});

describe("allowed-findings", () => {
  test("empty: the defaults", () => {
    expect(parseAllowedFindings("")).toEqual(DEFAULT_ALLOWED);
    expect(parseAllowedFindings(" \n ")).toEqual(DEFAULT_ALLOWED);
  });

  test("one kind per line, or comma-separated, with `:` or `=`, over the defaults", () => {
    expect(parseAllowedFindings("minor: 8\nperformance: 0\n")).toEqual({
      ...DEFAULT_ALLOWED,
      minor: 8,
      performance: 0,
    });
    expect(parseAllowedFindings("duplication=1, conventions = 2")).toEqual({
      ...DEFAULT_ALLOWED,
      duplication: 1,
      conventions: 2,
    });
  });

  test("an unknown kind, a missing number or a number past 100 is an error", () => {
    expect(() => parseAllowedFindings("major: 3")).toThrow(
      'no kind "major", only minor, performance, duplication, conventions',
    );
    expect(() => parseAllowedFindings("minor")).toThrow(
      '"minor" is not `kind: number`',
    );
    expect(() => parseAllowedFindings("minor: -1")).toThrow(
      "is not `kind: number`",
    );
    expect(() => parseAllowedFindings("minor: 101")).toThrow(
      "minor is at most 100, not 101",
    );
  });

  test("the improvements looked for: the categories above 0", () => {
    expect(improvementCategories(DEFAULT_ALLOWED)).toEqual([
      "performance",
      "duplication",
      "conventions",
    ]);
    expect(
      improvementCategories(
        parseAllowedFindings("performance: 0, conventions: 0"),
      ),
    ).toEqual(["duplication"]);
    expect(
      improvementCategories(
        parseAllowedFindings("performance: 0, duplication: 0, conventions: 0"),
      ),
    ).toEqual([]);
  });
});

describe("a first review's limits", () => {
  test("are the allowed numbers up to the reference size, then grow by the square root of the diff", () => {
    for (const lines of [0, 10, REFERENCE_LINES])
      expect(scaled(5, lines)).toBe(5);
    expect(scaled(5, 4 * REFERENCE_LINES)).toBe(10);
    expect(scaled(3, 4 * REFERENCE_LINES)).toBe(6);
    expect(findingLimits(DEFAULT_ALLOWED, first(5_000))).toEqual({
      minor: 14,
      performance: 9,
      duplication: 9,
      conventions: 9,
    });
    expect(findingLimits(DEFAULT_ALLOWED, first(20_000)).minor).toBe(29);
  });

  test("a kind set to 0 stays at 0", () => {
    expect(scaled(0, 50_000)).toBe(0);
  });
});

describe("a later review's limits", () => {
  test("no new minor issue, whatever changed", () => {
    expect(findingLimits(DEFAULT_ALLOWED, later(5_000, 5_000)).minor).toBe(0);
    expect(
      findingLimits(DEFAULT_ALLOWED, { lines: 5_000, later: true }).minor,
    ).toBe(0);
  });

  test("improvements in proportion to what changed since, at least one when anything did", () => {
    expect(findingLimits(DEFAULT_ALLOWED, later(5_000, 0))).toEqual({
      minor: 0,
      performance: 0,
      duplication: 0,
      conventions: 0,
    });
    expect(findingLimits(DEFAULT_ALLOWED, later(5_000, 10)).performance).toBe(
      1,
    );
    expect(findingLimits(DEFAULT_ALLOWED, later(5_000, 300)).performance).toBe(
      2,
    );
    expect(
      findingLimits(DEFAULT_ALLOWED, later(5_000, REFERENCE_LINES)).performance,
    ).toBe(3);
  });

  test("when the earlier review didn't look for improvements, the whole diff's", () => {
    expect(
      findingLimits(DEFAULT_ALLOWED, { lines: 5_000, later: true }),
    ).toEqual({ minor: 0, performance: 9, duplication: 9, conventions: 9 });
  });

  test("past the reference size, what a first review of that size would get", () => {
    expect(
      findingLimits(DEFAULT_ALLOWED, later(9_000, 5_000)).performance,
    ).toBe(9);
  });
});
