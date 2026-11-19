import { describe, expect, test } from "bun:test";
import {
  buildReview,
  commentableLines,
  type Finding,
  findingMarker,
  findingOf,
  HEADING,
  type PostedComment,
  type PostedReview,
  parseReviewFile,
  postedByRun,
  runLink,
  supersede,
} from "./github-review.ts";

// Two hunks of src/a.ts at the PR's head: lines 10-13 (11 added, the base's old
// 11 removed) and 40-41 (41 added).
const patch = [
  "@@ -10,3 +10,4 @@ function a() {",
  " const x = 1;",
  "-const y = 2;",
  "+const y = 3;",
  "+const z = 4;",
  " return x;",
  "@@ -38,2 +40,2 @@ function b() {",
  " const w = 0;",
  "+const v = 5;",
  "\\ No newline at end of file",
].join("\n");
const ROOT = "/home/dev/r";
const commentable = commentableLines([
  { filename: "src/a.ts", patch },
  { filename: "logo.png" }, // binary: no patch
]);

const finding = (overrides: Partial<Finding>): Finding => ({
  severity: "major",
  title: "Off by one",
  body: "The loop skips the last item.",
  ...overrides,
});
const review = (findings: Finding[]) =>
  buildReview({ summary: "Adds things.", findings }, commentable, "footer");

describe("commentable lines", () => {
  test("are the head's added and context lines, with their hunk; removed lines and binary files have none", () => {
    expect([...(commentable.get("src/a.ts") ?? [])]).toEqual([
      [10, 0],
      [11, 0],
      [12, 0],
      [13, 0],
      [40, 1],
      [41, 1],
    ]);
    expect(commentable.get("logo.png")?.size).toBe(0);
  });
});

describe("review", () => {
  test("a finding on a diff line is a comment there; elsewhere, or about the whole PR, it's in the body", () => {
    const posted = review([
      finding({ path: "src/a.ts", line: 12 }),
      finding({ path: "src/a.ts", line: 30, title: "Outside the hunks" }),
      finding({ path: "logo.png", line: 1, title: "On a binary" }),
      finding({ title: "About the whole PR" }),
    ]);
    expect(posted.comments).toEqual([
      {
        path: "src/a.ts",
        line: 12,
        side: "RIGHT",
        body: "🟠 **Major: Off by one**\n\nThe loop skips the last item.",
      },
    ]);
    expect(posted.body).toContain("**Major: Outside the hunks** `src/a.ts:30`");
    expect(posted.body).toContain("**Major: On a binary** `logo.png:1`");
    expect(posted.body).toContain("**Major: About the whole PR**\n");
  });

  test("a suggestion off the diff's lines is kept in the body, as a code block", () => {
    const posted = review([
      finding({
        path: "src/a.ts",
        line: 30,
        suggestion: "const fixed = true;",
      }),
    ]);
    expect(posted.body).toContain(
      "Suggested change:\n  \n  ```\n  const fixed = true;\n  ```",
    );
  });

  test("a range stays one when it's within a hunk; across hunks, its last line alone, without its suggestion", () => {
    const [within, across] = review([
      finding({
        path: "src/a.ts",
        startLine: 10,
        line: 13,
        suggestion: "fixed",
      }),
      finding({
        path: "src/a.ts",
        startLine: 12,
        line: 41,
        suggestion: "fixed",
      }),
    ]).comments;
    expect(within).toMatchObject({
      start_line: 10,
      start_side: "RIGHT",
      line: 13,
    });
    expect(within?.body).toContain("```suggestion\nfixed\n```");
    expect(across).not.toHaveProperty("start_line");
    expect(across?.line).toBe(41);
    expect(across?.body).not.toContain("suggestion");
  });

  test("a suggestion's fence is longer than any backticks in it", () => {
    const [comment] = review([
      finding({
        path: "src/a.ts",
        line: 12,
        suggestion: "see ```js``` and ````",
      }),
    ]).comments;
    expect(comment?.body).toEndWith(
      "\n\n`````suggestion\nsee ```js``` and ````\n`````",
    );
  });

  test("the body says whether it blocks, with the counts per severity, most severe first, or says LGTM", () => {
    const posted = review([
      finding({ severity: "minor", title: "Nit" }),
      finding({ severity: "critical", title: "Leaks a key" }),
    ]);
    expect(posted.body).toStartWith(
      `${HEADING}\n\n🛑 **Blocking**: 🔴 1 critical · 🟠 0 major · 🟡 1 minor\n\n`,
    );
    expect(posted.body.indexOf("Leaks a key")).toBeLessThan(
      posted.body.indexOf("Nit"),
    );
    expect(
      review([finding({ severity: "minor" }), finding({ severity: "minor" })])
        .body,
    ).toContain("✅ **Not blocking**: 🟡 2 minor, optional\n\nAdds things.");
    expect(review([]).body).toContain(
      "✅ **LGTM**: nothing flagged.\n\nAdds things.",
    );
    expect(review([]).body).toEndWith("<sub>footer</sub>");
  });

  test("a minor finding is never a comment: it's listed, collapsed, at the end of the body", () => {
    const posted = review([
      finding({
        severity: "minor",
        title: "Stale comment",
        path: "src/a.ts",
        line: 12,
        suggestion: "// ok",
      }),
      finding({ path: "src/a.ts", line: 11 }),
    ]);
    expect(posted.comments.map((comment) => comment.line)).toEqual([11]);
    expect(posted.body).toContain(
      [
        "<details><summary>🟡 1 minor, optional</summary>",
        "- 🟡 **Minor: Stale comment** `src/a.ts:12`\n\n  The loop skips the last item.\n  \n  Suggested change:\n  \n  ```\n  // ok\n  ```",
        "</details>\n\n<sub>footer</sub>",
      ].join("\n\n"),
    );
  });

  test("improvements never block, and are listed apart, by category, collapsed, with their agent's summary", () => {
    const improvement = (
      category: "performance" | "duplication" | "conventions",
      title: string,
    ) =>
      finding({
        severity: "minor",
        category,
        title,
        path: "src/a.ts",
        line: 11,
      });
    const posted = buildReview(
      {
        summary: "Adds things.",
        findings: [
          { ...improvement("duplication", "Reuse quiet()"), id: "F2" },
          finding({ severity: "minor", title: "Nit" }),
          { ...improvement("performance", "Query in a loop"), id: "F3" },
        ],
        improvements: { summary: "Two worth making." },
      },
      commentable,
      "footer",
    );
    expect(posted.comments).toEqual([]);
    expect(posted.body).toContain(
      "✅ **Not blocking**: 🟡 1 minor · 💡 2 improvements, optional",
    );
    expect(posted.body).toContain(
      [
        "<details><summary>💡 2 improvements, optional: ⚡ 1 performance · ♻️ 1 duplication</summary>",
        "Two worth making.",
        "- ⚡ **Performance · F3: Query in a loop** `src/a.ts:11`",
      ].join("\n\n"),
    );
    expect(posted.body).toContain(
      "- ♻️ **Duplication · F2: Reuse quiet()** `src/a.ts:11`",
    );
    // The minor issues first, then the improvements.
    expect(posted.body.indexOf("Nit")).toBeLessThan(
      posted.body.indexOf("Query in a loop"),
    );
    const blocking = review([finding({}), improvement("conventions", "c")]);
    expect(blocking.body).toContain(
      "🛑 **Blocking**: 🔴 0 critical · 🟠 1 major · 🟡 0 minor · 💡 1 improvement\n\n",
    );
    expect(review([improvement("conventions", "c")]).body).toContain(
      "✅ **Not blocking**: 💡 1 improvement, optional",
    );
  });

  test("says when the improvements weren't reviewed", () => {
    const posted = buildReview(
      {
        summary: "Adds things.",
        findings: [],
        improvements: { failed: "the improvements agent took too long" },
      },
      commentable,
      "footer",
    );
    expect(posted.body).toContain(
      "💡 **Improvements not reviewed**: the improvements agent took too long\n\n<sub>footer</sub>",
    );
    expect(review([]).body).not.toContain("Improvements");
  });

  test("cut inside the minor findings, closes them so the footer stays in view", () => {
    const posted = buildReview(
      {
        summary: "s",
        findings: [finding({ severity: "minor", body: "x".repeat(70_000) })],
      },
      commentable,
      "footer",
    );
    expect(posted.body).toEndWith(
      "x\n\n</details>\n\n… (cut: too long for GitHub)\n\n<sub>footer</sub>",
    );
  });

  test("a finding's evidence is collapsed under it, after its suggestion, on a comment or in the body", () => {
    const posted = buildReview(
      {
        summary: "s",
        findings: [
          {
            ...finding({
              path: "src/a.ts",
              line: 12,
              suggestion: "const y = 2;",
              evidence: "`a()` calls it: <b>\n```",
            }),
            id: "F1",
          },
          finding({ title: "Elsewhere", evidence: "Seen in b.ts:3." }),
        ],
      },
      commentable,
      "footer",
    );
    expect(posted.comments[0]?.body).toEndWith(
      [
        "```suggestion\nconst y = 2;\n```",
        "<details><summary>Evidence</summary>",
        "`a()` calls it: <\u200bb>\n```\n```",
        "</details>",
        findingMarker("F1"),
      ].join("\n\n"),
    );
    expect(posted.body).toContain(
      "**Major: Elsewhere**\n\n  The loop skips the last item.\n  \n  <details><summary>Evidence</summary>\n  \n  Seen in b.ts:3.\n  \n  </details>",
    );
  });

  test("cut inside a minor finding's evidence, closes it and the minor findings", () => {
    const posted = buildReview(
      {
        summary: "s",
        findings: [
          finding({ title: "Elsewhere", evidence: "closed before the cut" }),
          finding({ severity: "minor", evidence: "x".repeat(70_000) }),
        ],
      },
      commentable,
      "footer",
    );
    expect(posted.body).toEndWith(
      "x\n\n</details>\n\n</details>\n\n… (cut: too long for GitHub)\n\n<sub>footer</sub>",
    );
  });

  test("a finding with an id shows it, and its comment ends with the marker the next review finds it by", () => {
    const posted = buildReview(
      {
        summary: "s",
        findings: [{ ...finding({ path: "src/a.ts", line: 12 }), id: "F7" }],
      },
      commentable,
      "footer",
    );
    const body = posted.comments[0]?.body;
    expect(body).toStartWith("🟠 **Major · F7: Off by one**");
    expect(body).toEndWith(`\n\n${findingMarker("F7")}`);
    expect(findingOf(body)).toBe("F7");
    // Quoted in a reply, the marker isn't at the end: the reply is no finding.
    expect(findingOf(`> ${body}\n\nIt's intended.`)).toBeUndefined();
  });

  test("ends with the state, which a long review is cut to make room for", () => {
    const state = `<!-- agent-review-state:1:${"A".repeat(19_000)} -->`;
    const posted = buildReview(
      { summary: "x".repeat(64_000), findings: [], state },
      commentable,
      "footer",
    );
    expect(posted.body).toContain("… (cut: too long for GitHub)");
    expect(posted.body).toEndWith(`<sub>footer</sub>\n\n${state}`);
    expect(posted.body.length).toBeLessThan(65_536);
  });

  test("says what became of the earlier findings", () => {
    const posted = buildReview(
      {
        summary: "s",
        findings: [],
        since: {
          head: "0123456789abcdef0123456789abcdef01234567",
          fixed: [
            {
              id: "F1",
              title: "Off by one",
              note: "The loop now ends at length.",
            },
          ],
          dismissed: [{ id: "F2", title: "Unbounded", note: "" }],
          open: ["F3"],
          unchecked: ["F4"],
        },
      },
      commentable,
      "footer",
    );
    expect(posted.body).toContain(
      [
        "#### Since the review of `0123456`\n",
        "- ✅ **F1** fixed: Off by one. The loop now ends at length.",
        "- 💤 **F2** dismissed: Unbounded",
        "- 🔁 Still open: F3.",
        "- ❔ Not checked again, posted as they were: F4.",
      ].join("\n"),
    );
  });
});

describe("the agent's text", () => {
  // quiet() itself: shared/src/markdown.test.ts.
  test("is quieted in a comment; its suggestion is code, posted as is", () => {
    const [comment] = review([
      finding({
        path: "src/a.ts",
        line: 12,
        title: "@bob",
        suggestion: "@keep",
      }),
    ]).comments;
    expect(comment?.body).toContain("@\u200bbob");
    expect(comment?.body).toContain("suggestion\n@keep\n");
  });
});

describe("the agent's file", () => {
  test("is checked: a bad severity, a missing summary or a bad line is an error naming it", () => {
    expect(() => parseReviewFile("not json", ROOT)).toThrow("not JSON");
    expect(() =>
      parseReviewFile(JSON.stringify({ findings: [] }), ROOT),
    ).toThrow("`summary`");
    expect(() =>
      parseReviewFile(
        JSON.stringify({
          summary: "s",
          findings: [{ severity: "blocker", title: "t", body: "" }],
        }),
        ROOT,
      ),
    ).toThrow("findings[0].severity");
    expect(() =>
      parseReviewFile(
        JSON.stringify({
          summary: "s",
          findings: [{ severity: "minor", title: "t", body: "", line: 0 }],
        }),
        ROOT,
      ),
    ).toThrow("findings[0]: lines");
    expect(() =>
      parseReviewFile(
        JSON.stringify({
          summary: "s",
          findings: [
            { severity: "minor", title: "t", body: "", path: "x` @a `" },
          ],
        }),
        ROOT,
      ),
    ).toThrow("findings[0].path");
    expect(() =>
      parseReviewFile(
        JSON.stringify({
          summary: "s",
          findings: [{ severity: "minor", title: "t", body: "", evidence: 3 }],
        }),
        ROOT,
      ),
    ).toThrow("findings[0].evidence");
  });

  test("of improvements: a category instead of a severity, and never blocking", () => {
    const parse = (finding: Record<string, unknown>) =>
      parseReviewFile(
        JSON.stringify({ summary: "s", findings: [finding] }),
        ROOT,
        new Set(),
        "improvements",
      );
    expect(
      parse({
        category: "performance",
        severity: "critical",
        title: "t",
        body: "b",
      }).findings,
    ).toEqual([
      { severity: "minor", category: "performance", title: "t", body: "b" },
    ]);
    expect(() => parse({ severity: "minor", title: "t", body: "b" })).toThrow(
      "findings[0].category must be one of performance,duplication,conventions",
    );
    // An issue's file has no category.
    expect(
      parseReviewFile(
        JSON.stringify({
          summary: "s",
          findings: [
            {
              severity: "major",
              category: "performance",
              title: "t",
              body: "b",
            },
          ],
        }),
        ROOT,
      ).findings,
    ).toEqual([{ severity: "major", title: "t", body: "b" }]);
  });

  test("takes null as absent, and an absolute path in the sandbox as relative", () => {
    const { findings } = parseReviewFile(
      JSON.stringify({
        summary: "s",
        findings: [
          {
            severity: "minor",
            title: "t",
            body: "b",
            path: null,
            line: null,
            startLine: null,
            suggestion: null,
            evidence: "  ",
          },
          {
            severity: "minor",
            title: "t",
            body: "b",
            path: "/home/dev/r/src/a.ts",
            line: 3,
            evidence: " seen \n",
          },
        ],
      }),
      ROOT,
    );
    expect(findings).toEqual([
      { severity: "minor", title: "t", body: "b" },
      {
        severity: "minor",
        title: "t",
        body: "b",
        path: "src/a.ts",
        line: 3,
        evidence: "seen",
      },
    ]);
  });

  test("is normalized: paths from the root, a range only when it ends after its start", () => {
    const { findings } = parseReviewFile(
      JSON.stringify({
        summary: " s ",
        findings: [
          {
            severity: "minor",
            title: "t",
            body: "b",
            path: "./src/a.ts",
            line: 3,
            startLine: 3,
          },
        ],
      }),
      ROOT,
    );
    expect(findings).toEqual([
      { severity: "minor", title: "t", body: "b", path: "src/a.ts", line: 3 },
    ]);
  });

  test("rules on the earlier review's open findings only, once each, and carries only the open ones", () => {
    const earlier = new Set(["F1", "F2"]);
    const file = (previous: unknown, findings: unknown[] = []) =>
      JSON.stringify({ summary: "s", previous, findings });
    const carried = (previous: string) => ({
      severity: "minor",
      title: "t",
      body: "b",
      previous,
    });
    expect(parseReviewFile(file(undefined), ROOT).previous).toEqual([]);
    expect(
      parseReviewFile(
        file([{ id: "F1", status: "fixed", note: " done " }], [carried("F2")]),
        ROOT,
        earlier,
      ),
    ).toMatchObject({
      previous: [{ id: "F1", status: "fixed", note: "done" }],
      findings: [{ previous: "F2" }],
    });
    expect(() =>
      parseReviewFile(file([{ id: "F9", status: "fixed" }]), ROOT, earlier),
    ).toThrow("previous[0].id is no finding of the earlier review");
    expect(() =>
      parseReviewFile(file([{ id: "F1", status: "gone" }]), ROOT, earlier),
    ).toThrow("previous[0].status");
    expect(() =>
      parseReviewFile(
        file([
          { id: "F1", status: "open" },
          { id: "F1", status: "fixed" },
        ]),
        ROOT,
        earlier,
      ),
    ).toThrow("F1 is ruled on twice");
    expect(() =>
      parseReviewFile(file([], [carried("F9")]), ROOT, earlier),
    ).toThrow("findings[0].previous");
    expect(() =>
      parseReviewFile(file([], [carried("F1"), carried("F1")]), ROOT, earlier),
    ).toThrow("F1 is carried twice");
    expect(() =>
      parseReviewFile(
        file([{ id: "F1", status: "fixed" }], [carried("F1")]),
        ROOT,
        earlier,
      ),
    ).toThrow("F1 is fixed");
  });

  test("drops the suggestion of a range that ends before its start: it was written for lines we can't tell", () => {
    const { findings } = parseReviewFile(
      JSON.stringify({
        summary: "s",
        findings: [
          {
            severity: "minor",
            title: "t",
            body: "b",
            path: "a.ts",
            line: 3,
            startLine: 9,
            suggestion: "x",
          },
        ],
      }),
      ROOT,
    );
    expect(findings).toEqual([
      { severity: "minor", title: "t", body: "b", path: "a.ts", line: 3 },
    ]);
  });
});

describe("a new review", () => {
  const bot = { login: "github-actions[bot]" };
  const posted = (id: number, body: string, user = bot): PostedReview => ({
    id,
    node_id: `R${id}`,
    body,
    user,
  });
  const comment = (
    id: number,
    review: number | null,
    inReplyTo?: number,
  ): PostedComment => ({
    id,
    node_id: `C${id}`,
    pull_request_review_id: review,
    ...(inReplyTo === undefined ? {} : { in_reply_to_id: inReplyTo }),
  });

  test("collapses the earlier agent reviews and their comments, deletes nothing and leaves replies alone", () => {
    const latest = posted(5, `${HEADING}\n\nnew`);
    const reviews = [
      posted(1, `${HEADING}\n\nold`),
      posted(2, "### Agent review\n\nolder fallback"),
      posted(3, "a person's review", { login: "alice" }),
      posted(4, "another workflow's review"),
      latest,
      posted(6, `${HEADING}\n\na rerun after this one`),
    ];
    const comments = [
      comment(10, 1),
      comment(11, 1),
      comment(12, 3, 11), // alice replied to 11
      comment(13, 2),
      comment(14, 3),
      comment(15, 4),
      comment(16, 5),
      comment(17, 6),
    ];
    expect(supersede(latest, reviews, comments)).toEqual([
      "R1",
      "R2",
      "C10",
      "C11",
      "C13",
    ]);
  });

  test("after an error that doesn't say, is found by its run's link, on its head, from the job's account", () => {
    const run = "https://github.com/o/r/actions/runs/7";
    const footer = (url: string) =>
      `${HEADING}\n\nx\n\n<sub>… <a href="${url}">Run</a></sub>`;
    const mine = { ...posted(3, footer(run)), commit_id: "h" };
    const reviews = [
      {
        ...posted(1, footer("https://github.com/o/r/actions/runs/6")),
        commit_id: "h",
      },
      { ...posted(2, footer(run), { login: "mallory" }), commit_id: "h" },
      mine,
    ];
    expect(postedByRun(reviews, bot.login, "h", run)).toBe(mine);
    expect(postedByRun(reviews, bot.login, "other head", run)).toBeUndefined();
    expect(
      postedByRun(reviews.slice(0, 2), bot.login, "h", run),
    ).toBeUndefined();
  });

  test("after a re-run's error, doesn't take an earlier attempt's review of the same run and head for its own", () => {
    const attempt = (number: number) =>
      runLink("https://github.com", "o/r", "7", String(number));
    expect(attempt(2)).toBe("https://github.com/o/r/actions/runs/7/attempts/2");
    const footer = (url: string) =>
      `${HEADING}\n\nx\n\n<sub>… <a href="${url}">Run</a></sub>`;
    const first = { ...posted(1, footer(attempt(1))), commit_id: "h" };
    const tenth = { ...posted(2, footer(attempt(10))), commit_id: "h" };
    // Attempt 2's POST failed, and nothing of it is there: attempt 1's review
    // isn't its own.
    expect(
      postedByRun([first, tenth], bot.login, "h", attempt(2)),
    ).toBeUndefined();
    expect(postedByRun([first, tenth], bot.login, "h", attempt(1))).toBe(first);
    const second = { ...posted(3, footer(attempt(2))), commit_id: "h" };
    expect(
      postedByRun([first, tenth, second], bot.login, "h", attempt(2)),
    ).toBe(second);
  });

  test("leaves everything alone on a PR with no earlier agent review", () => {
    const latest = posted(5, `${HEADING}\n\nnew`);
    expect(supersede(latest, [latest], [comment(16, 5)])).toEqual([]);
  });
});
