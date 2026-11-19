import { describe, expect, test } from "bun:test";
import { redact } from "./sandbox.ts";

describe("an exec error", () => {
  test("loses the credentials git or gh could print", () => {
    expect(
      redact(
        "fatal: unable to access 'https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git/'",
      ),
    ).toBe("fatal: unable to access 'https://***@github.com/o/r.git/'");
    expect(redact(`token ${"github_pat_"}${"A1_".repeat(10)} refused`)).toBe(
      "token *** refused",
    );
    expect(redact("gh: HTTP 404 (https://api.github.com/repos/o/r)")).toBe(
      "gh: HTTP 404 (https://api.github.com/repos/o/r)",
    );
  });
});
