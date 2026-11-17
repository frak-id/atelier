import { describe, expect, test } from "bun:test";
import { type EarlierReview, reviewPrompt } from "./prompt.ts";

const HEAD = "1111111111111111111111111111111111111111";
const prompt = (delta?: EarlierReview["delta"]) =>
  reviewPrompt({
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
          },
        }
      : {}),
    output: "/home/dev/review.json",
  });

test("gives the agent the job's time for the review", () => {
  expect(prompt()).toContain("you have up to 25 minutes for all of it");
});

describe("what a review reports", () => {
  test("the first: critical and major findings, and the few minor ones most worth fixing", () => {
    const text = prompt();
    expect(text).toContain(
      "and at most 5 minor ones: those most worth\n   fixing, best first",
    );
    expect(text).toContain("at most 5 findings are `minor`");
    expect(text).not.toContain("## The earlier review");
    expect(text).not.toContain(
      "Only critical and major problems are new findings now",
    );
  });

  test("a later one: the whole PR again, but only critical and major problems as new findings", () => {
    const text = prompt("written");
    expect(text).toContain(
      "review the whole PR again with fresh eyes, every patch and not only what changed",
    );
    expect(text).toContain(
      "Only critical and major problems are new findings now",
    );
    expect(text).toContain(
      "what to report:\n     its new findings, critical and major only",
    );
    expect(text).toContain("a new minor finding is dropped");
    expect(text).not.toContain("at most 5 minor");
  });

  test("a later one takes a person's deferral as dismissing the finding, without weighing it", () => {
    expect(prompt("written")).toContain(
      "Deferring is\n     the author's call: don't weigh their reason",
    );
  });

  test("a later one still rules on every earlier finding, minor ones included: only new findings are limited", () => {
    const text = prompt("written");
    expect(text).toContain(
      "also rules on each earlier\n     finding, minor ones included",
    );
    expect(text).toContain(
      "This limits new\n   findings only: every earlier finding still gets its ruling",
    );
  });
});

test("says where each file's patch is: its directories carry a `.d`, as diff-files.sh writes them", () => {
  expect(prompt("written")).toContain(
    "`/home/dev/diff/diff/src.d/app.d/x.ts.patch`",
  );
});

describe("what the prompt says about the earlier review's head", () => {
  test("points to the delta when diff-files.sh wrote one", () => {
    const text = prompt("written");
    expect(text).toContain(
      "What changed since, on the PR's files, is in `/home/dev/diff/delta/`",
    );
    expect(text).toContain(
      "review what changed since (`/home/dev/diff/delta/`) in depth",
    );
    expect(text).not.toContain("force-pushed");
    expect(text).not.toContain("nothing was pushed since");
  });

  test("says the branch was force-pushed only when that head can't be fetched", () => {
    const text = prompt("unavailable");
    expect(text).toContain("(the branch was force-pushed)");
    expect(text).toContain("review the code those findings point to in depth");
    expect(text).not.toContain("nothing was pushed since");
  });

  test("says nothing changed when the earlier review saw this very head", () => {
    const text = prompt("unchanged");
    expect(text).toContain(
      "That is the head you are reviewing: nothing was pushed since",
    );
    expect(text).toContain("review the code those findings point to in depth");
    expect(text).not.toContain("force-pushed");
    expect(text).not.toContain("/delta/");
  });
});
