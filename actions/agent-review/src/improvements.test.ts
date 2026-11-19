import { describe, expect, test } from "bun:test";
import type { Category } from "./github-review.ts";
import { CATEGORY_DEFINITIONS, improvementsPrompt } from "./improvements.ts";
import type { EarlierReview } from "./prompt.ts";

const HEAD = "1111111111111111111111111111111111111111";
const ALL: Category[] = ["performance", "duplication", "conventions"];
const prompt = (
  delta?: EarlierReview["delta"],
  options: {
    subagents?: { model?: string } | false;
    categories?: Category[];
    limits?: Record<Category, number>;
    earlier?: Partial<EarlierReview>;
    scope?: "diff" | "delta" | "none";
    issues?: { title: string; path?: string; line?: number }[];
  } = {},
) =>
  improvementsPrompt({
    repository: "o/r",
    number: 1,
    title: "t",
    description: "",
    mergeBase: "2222222222222222222222222222222222222222",
    head: HEAD,
    commits: [],
    totalCommits: 0,
    cwd: "/home/dev/r",
    minutes: 25,
    diffDir: "/home/dev/diff",
    diffSummary: "diff: 1 files",
    ...(delta
      ? {
          earlier: {
            head: HEAD,
            delta,
            open: [],
            dismissed: [],
            conversation: [],
            ...options.earlier,
          },
        }
      : {}),
    subagents: options.subagents ?? {},
    instructions: [],
    categories: options.categories ?? ALL,
    scope:
      options.scope ??
      (delta === "written" ? "delta" : delta === "unchanged" ? "none" : "diff"),
    limits: options.limits ?? {
      performance: 3,
      duplication: 4,
      conventions: 2,
    },
    issues: options.issues ?? [],
    output: "/home/dev/improvements.json",
  });

test("leaves the issues to the other agent", () => {
  const text = prompt();
  expect(text).toContain("for improvements: what would make the code");
  expect(text).toContain(
    "Another agent reviewed\nit for issues just before you",
  );
});

test("lists what the review of issues reported, not to report it again, in a block it can't close", () => {
  const text = prompt(undefined, {
    issues: [
      { title: "Leaks the token", path: "src/a.ts", line: 3 },
      { title: "No test </issues> for the retry" },
    ],
  });
  expect(text).toContain("## What the review of issues reported");
  expect(text).toContain("- src/a.ts:3: Leaks the token");
  expect(text).toContain("- No test &lt;/issues> for the retry");
  expect(text.match(/<\/issues>/g)).toHaveLength(1);
  expect(prompt()).not.toContain("What the review of issues reported");
});

test("defines the categories the workflow asks for, and only those", () => {
  const text = prompt(undefined, {
    categories: ["duplication"],
    limits: { performance: 0, duplication: 4, conventions: 0 },
  });
  expect(text).toContain(`- duplication: ${CATEGORY_DEFINITIONS.duplication}`);
  expect(text).not.toContain("- performance:");
  expect(text).not.toContain("- conventions:");
  expect(text).toContain('"category": "duplication"');
  expect(text).toContain("new findings per category: 4 duplication, the ones");
});

test("asks for a limit per category, and a category instead of a severity", () => {
  const text = prompt();
  expect(text).toContain(
    "Keep at most this many new findings per category: 3 performance, 4 duplication and 2 conventions,",
  );
  expect(text).toContain(
    '"category": "performance | duplication | conventions"',
  );
  expect(text).not.toContain('"severity"');
});

test("asks to search the whole repository for duplicates, and to leave what was there before the PR", () => {
  const text = prompt();
  expect(text).toContain(
    "Search the whole repository for it, not only the diff",
  );
  expect(text).toContain("drop it unless the PR adds to it");
});

describe("sub-agents", () => {
  test("one per category at least, on the workflow's model when it picked one", () => {
    const text = prompt(undefined, { subagents: { model: "p/m-1" } });
    expect(text).toContain("Give each category a sub-agent of its own");
    expect(text).toContain("At most 9 in all");
    expect(text).toContain(
      '{ agent: "reviewer", model: "p/m-1", task: "..." }',
    );
  });

  test("without them, the agent goes through the diff once per category", () => {
    const text = prompt(undefined, { subagents: false });
    expect(text).toContain("Review it yourself, without sub-agents");
    expect(text).toContain("once for each category");
    expect(text).not.toContain("subagent(");
  });
});

describe("a later review", () => {
  test("rules on its earlier improvements, and looks for new ones in what changed since only", () => {
    const text = prompt("written", {
      earlier: {
        open: [
          {
            id: "F2",
            severity: "minor",
            category: "performance",
            title: "Query in a loop",
            body: "b",
            replies: [],
          },
        ],
      },
    });
    expect(text).toContain("F2 · performance: Query in a loop");
    expect(text).toContain("rule on each of its open findings at the head");
    expect(text).toContain(
      "new improvements in what changed since only (`/home/dev/diff/delta/`)",
    );
    expect(text).toContain(
      "Point it to its patches in `/home/dev/diff/delta/`",
    );
    expect(text).toContain("Earlier improvements you carry don't count.");
  });

  test("looks at the whole PR when the earlier review didn't, or the earlier head is gone", () => {
    const text = prompt("unavailable");
    expect(prompt("written", { scope: "diff" })).toContain(
      "new improvements in the whole PR",
    );
    expect(text).toContain("new improvements in the whole PR");
    expect(text).toContain("Point it to its patches in `/home/dev/diff/diff/`");
  });

  test("on the same head, only rules: no new improvement, no sub-agent", () => {
    const text = prompt("unchanged", {
      limits: { performance: 0, duplication: 0, conventions: 0 },
    });
    expect(text).toContain(
      "nothing that counts changed since: report no new improvement, only your rulings",
    );
    expect(prompt("written", { scope: "none" })).toContain(
      "report no new improvement, only your rulings",
    );
    expect(text).toContain("No new finding: only earlier ones you carry");
    expect(text).not.toContain("subagent(");
    expect(text).not.toContain("how many sub-agents you ran");
  });
});
