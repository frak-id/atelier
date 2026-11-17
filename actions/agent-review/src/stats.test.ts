import { expect, test } from "bun:test";
import { HEADING, type PostedReview } from "./github-review.ts";
import { encodeState, type ReviewState } from "./memory.ts";
import { findingsReport, type PullFindings, pullFindings } from "./stats.ts";

const BOT = "github-actions[bot]";
const [A, B] = ["a".repeat(40), "b".repeat(40)];
const finding = (id: string, severity: "critical" | "major" | "minor") => ({
  id,
  severity,
  title: `${id} title`,
  body: "",
});
const posted = (
  id: number,
  state: ReviewState,
  login = BOT,
  heading = HEADING,
): PostedReview => ({
  id,
  node_id: `R${id}`,
  body: `${heading}\n\ntext\n\n${encodeState(state)}`,
  user: { login },
});

// F1 fixed after the first review, F3 dismissed, F2 still open (carried as
// major, posted as minor).
const reviews = [
  posted(20, {
    head: B,
    nextId: 4,
    open: [{ ...finding("F2", "major") }],
    dismissed: [{ id: "F3", title: "F3 title", note: "follow-up" }],
  }),
  posted(10, {
    head: A,
    nextId: 4,
    open: [
      finding("F1", "major"),
      finding("F2", "minor"),
      finding("F3", "critical"),
    ],
    dismissed: [],
  }),
  // Not the job's, or not an agent review: not read.
  posted(
    30,
    { head: A, nextId: 9, open: [finding("F8", "critical")], dismissed: [] },
    "someone",
  ),
  posted(
    40,
    { head: A, nextId: 9, open: [finding("F8", "critical")], dismissed: [] },
    BOT,
    "### Other",
  ),
];

test("rebuilds what became of each finding from the states its reviews hid, oldest first", () => {
  expect(pullFindings(reviews, BOT, B)).toEqual({
    reviews: 2,
    stale: false,
    findings: [
      { id: "F1", severity: "major", outcome: "fixed" },
      { id: "F2", severity: "minor", outcome: "open" },
      { id: "F3", severity: "critical", outcome: "dismissed" },
    ],
  });
});

test("says when the PR was merged at a head its last review didn't see", () => {
  expect(pullFindings(reviews, BOT, A)?.stale).toBe(true);
});

test("a PR the agent never reviewed has none", () => {
  expect(pullFindings(reviews.slice(2), BOT, A)).toBeUndefined();
  expect(pullFindings([], BOT, A)).toBeUndefined();
});

test("counts per severity, with the share fixed", () => {
  const pulls: PullFindings[] = [
    pullFindings(reviews, BOT, A) as PullFindings,
    { reviews: 1, stale: false, findings: [] },
  ];
  const report = findingsReport("o/r", 5, pulls);
  expect(report).toContain(
    "5 merged PRs, 2 reviewed by the agent (1.5 reviews each on average, 1 with no finding). 1 got a push their last review didn't see",
  );
  expect(report).toContain("| critical | 1 | 0 | 1 | 0 | 0% |");
  expect(report).toContain("| major | 1 | 1 | 0 | 0 | 100% |");
  expect(report).toContain("| minor | 1 | 0 | 0 | 1 | 0% |");
  expect(report).toContain("| all | 3 | 1 | 1 | 1 | 33% |");
  expect(findingsReport("o/r", 2, [])).toContain(
    "2 merged PRs, none reviewed by the agent.",
  );
  expect(findingsReport("o/r", 2, [])).toContain("| all | 0 | 0 | 0 | 0 | – |");
});
