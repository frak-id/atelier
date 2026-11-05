import { describe, expect, test } from "bun:test";
import { parseGitResult } from "./task-result.ts";

const AT = "2026-11-05T10:00:00.000Z";

describe("parseGitResult", () => {
  test("reads every probe", () => {
    const out = [
      "branch=feat/x",
      "head=abc123",
      "ahead=2",
      "diff=3 files changed, 10 insertions(+), 1 deletion(-)",
    ].join("\n");
    expect(parseGitResult(out, AT)).toEqual({
      branch: "feat/x",
      headSha: "abc123",
      commitsAhead: 2,
      diffStat: "3 files changed, 10 insertions(+), 1 deletion(-)",
      capturedAt: AT,
    });
  });

  test("a clean branch without upstream drops the empty probes", () => {
    expect(
      parseGitResult("branch=main\nhead=abc\nahead=\ndiff=\n", AT),
    ).toEqual({ branch: "main", headSha: "abc", capturedAt: AT });
  });

  test("outside a repo there is no result", () => {
    expect(parseGitResult("", AT)).toBeUndefined();
  });
});
