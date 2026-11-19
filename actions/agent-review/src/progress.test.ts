import { describe, expect, test } from "bun:test";
import {
  PROGRESS_MARKER,
  progressComment,
  progressCommentId,
} from "./progress.ts";

const head = "0123456789abcdef";
const run = "https://github.com/o/r/actions/runs/1/attempts/1";
const sandboxUrl = "https://atelier.example.com/sandboxes/sbx-1/sessions";

describe("the progress comment", () => {
  test("links to the reviewer's sandbox while it runs, under the marker a later run finds it by", () => {
    const body = progressComment(
      { state: "running", sandboxUrl, minutes: 25 },
      head,
      run,
    );
    expect(body.startsWith(PROGRESS_MARKER)).toBe(true);
    expect(body).toContain(`(${sandboxUrl})`);
    expect(body).toContain("25 at most");
    expect(body).toContain("looking for issues first, then improvements");
    expect(body).toContain("`0123456`");
    expect(body).toContain(run);
  });

  test("once the review failed or stopped, says so and no longer links to the sandbox (destroyed)", () => {
    for (const state of ["failed", "stopped"] as const) {
      const body = progressComment({ state }, head, run);
      expect(body.startsWith(PROGRESS_MARKER)).toBe(true);
      expect(body).toContain(state);
      expect(body).not.toContain("atelier");
    }
  });

  test("stopped by a push to a draft, says the PR is reviewed once it's ready, not on the next push", () => {
    const body = progressComment({ state: "stopped", draft: true }, head, run);
    expect(body).toContain("stopped");
    expect(body).toContain("draft");
    expect(body).toContain("ready for review");
    expect(body).not.toContain("next push");
  });

  test("is the job's own: a person's comment quoting the marker is never updated or deleted", () => {
    const body = progressComment({ state: "failed" }, head, run);
    const comments = [
      { id: 1, body, user: { login: "someone" } },
      {
        id: 2,
        body: "### Agent review",
        user: { login: "github-actions[bot]" },
      },
      { id: 3, body, user: { login: "github-actions[bot]" } },
    ];
    expect(progressCommentId(comments)).toBe(3);
    expect(progressCommentId(comments.slice(0, 2))).toBeUndefined();
    expect(
      progressCommentId([{ id: 4, body: null, user: null }]),
    ).toBeUndefined();
  });
});
