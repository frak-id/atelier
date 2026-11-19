/**
 * How many new findings a review reports at most, for each kind that never
 * blocks: minor issues (prompt.ts), and each category of improvement
 * (improvements.ts). Critical and major issues have no limit.
 *
 * The workflow's `allowed-findings` gives each kind's number for a diff of up
 * to REFERENCE_LINES changed lines, lockfiles aside. A bigger diff gets more,
 * by the square root of its size: four times the diff, twice the findings.
 * More code has more worth saying, but a long list buries what matters, and
 * costs the author a round each. A kind set to 0 is not reported at all: with
 * every category at 0, no improvement is looked for.
 *
 * A later review reports no new minor issue: a new round of small things on
 * every push never ends. When the earlier review looked for improvements, a
 * later one reports new improvements on what changed since only, in proportion
 * to its size, past which it gets what a first review of that size would.
 */
import { CATEGORIES, type Category } from "./github-review.ts";

/** The kinds of findings with a limit. */
export const LIMITED = ["minor", ...CATEGORIES] as const;
export type Limited = (typeof LIMITED)[number];
export type Limits = Record<Limited, number>;

/** What `allowed-findings` sets when it leaves a kind out. */
export const DEFAULT_ALLOWED: Readonly<Limits> = {
  minor: 5,
  performance: 3,
  duplication: 3,
  conventions: 3,
};
/** The diff's size, in changed lines, the allowed numbers are for. */
export const REFERENCE_LINES = 600;
/** A number past this is a typo, not a limit. */
const MAX_ALLOWED = 100;

/**
 * The workflow's `allowed-findings`: `kind: number` entries, one per line or
 * comma-separated (`=` works too), on top of DEFAULT_ALLOWED. Throws with
 * what's wrong.
 */
export function parseAllowedFindings(text: string): Limits {
  const allowed = { ...DEFAULT_ALLOWED };
  for (const entry of text.split(/[\n,]/)) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const match = /^([a-z]+)\s*[:=]\s*(\d+)$/.exec(trimmed);
    if (!match)
      throw new Error(
        `allowed-findings: "${trimmed}" is not \`kind: number\` (${LIMITED.join(", ")})`,
      );
    const [, kind = "", count = ""] = match;
    if (!LIMITED.includes(kind as Limited))
      throw new Error(
        `allowed-findings: no kind "${kind}", only ${LIMITED.join(", ")}`,
      );
    const value = Number(count);
    if (value > MAX_ALLOWED)
      throw new Error(
        `allowed-findings: ${kind} is at most ${MAX_ALLOWED}, not ${value}`,
      );
    allowed[kind as Limited] = value;
  }
  return allowed;
}

/** The categories of improvement `allowed` asks for: none, and the review
 * looks for no improvement. */
export function improvementCategories(allowed: Limits): Category[] {
  return CATEGORIES.filter((category) => allowed[category] > 0);
}

/** The limit for `allowed` findings on a diff of `lines` changed lines: as is
 * up to REFERENCE_LINES, by the square root of the size past it. */
export function scaled(allowed: number, lines: number): number {
  return Math.round(
    allowed * Math.sqrt(Math.max(lines, REFERENCE_LINES) / REFERENCE_LINES),
  );
}

/**
 * The new findings a review of a diff of `lines` changed lines reports at most,
 * per kind. A `later` one reports no new minor issue. Improvements are limited
 * for the whole diff, or, with `improvementsSince`, for the lines changed since
 * an earlier review that looked for them.
 */
export function findingLimits(
  allowed: Limits,
  review: { lines: number; later: boolean; improvementsSince?: number },
): Limits {
  const since = review.improvementsSince;
  const limit = (kind: Limited) => {
    if (kind === "minor")
      return review.later ? 0 : scaled(allowed.minor, review.lines);
    if (since === undefined) return scaled(allowed[kind], review.lines);
    return Math.min(
      scaled(allowed[kind], since),
      Math.ceil((allowed[kind] * since) / REFERENCE_LINES),
    );
  };
  return Object.fromEntries(
    LIMITED.map((kind) => [kind, limit(kind)]),
  ) as Limits;
}
