import { describe, expect, test } from "bun:test";
import type { GitHubTokenStatus } from "./github-oauth.ts";
import { GitHubTokenValidator } from "./github-token-validator.ts";

/** A validator over an in-memory token table and a scripted GitHub. */
function setup(
  opts: {
    answer?: (token: string) => Promise<GitHubTokenStatus>;
    bypassed?: boolean;
  } = {},
) {
  const tokens: Record<string, string | undefined> = { "1": "gho_a" };
  const asked: string[] = [];
  let clock = 0;
  const validator = new GitHubTokenValidator({
    users: {
      getById: (id) =>
        id in tokens
          ? ({ id, kind: "human", githubAccessToken: tokens[id] } as never)
          : undefined,
      // The real compare-and-clear: a newer login's token is kept.
      dropGitHubToken: (id, token) => {
        if (tokens[id] !== token) return false;
        tokens[id] = undefined;
        return true;
      },
    },
    check: (token) => {
      asked.push(token);
      return opts.answer?.(token) ?? Promise.resolve("valid");
    },
    now: () => clock,
    waitMs: 20,
    bypassed: () => opts.bypassed ?? false,
  });
  return {
    validator,
    tokens,
    asked,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("GitHubTokenValidator.ensureValid", () => {
  test("asks GitHub at most every five minutes for an accepted token", async () => {
    const { validator, asked, advance } = setup();
    expect(await validator.ensureValid("1")).toBe(true);
    expect(await validator.ensureValid("1")).toBe(true);
    expect(asked).toEqual(["gho_a"]);
    advance(5 * 60 * 1000);
    expect(await validator.ensureValid("1")).toBe(true);
    expect(asked).toHaveLength(2);
  });

  test("a token GitHub rejects is dropped and the session refused", async () => {
    const { validator, tokens } = setup({
      answer: async () => "revoked",
    });
    expect(await validator.ensureValid("1")).toBe(false);
    expect(tokens["1"]).toBeUndefined();
    // No token left: refused without asking again.
    expect(await validator.ensureValid("1")).toBe(false);
  });

  test("no stored token is refused without asking GitHub", async () => {
    const { validator, asked } = setup();
    expect(await validator.ensureValid("unknown")).toBe(false);
    expect(asked).toEqual([]);
  });

  test("an unreachable GitHub keeps the session and is asked again", async () => {
    const { validator, asked, tokens } = setup({
      answer: async () => "unknown",
    });
    expect(await validator.ensureValid("1")).toBe(true);
    expect(await validator.ensureValid("1")).toBe(true);
    expect(asked).toHaveLength(2);
    expect(tokens["1"]).toBe("gho_a");
  });

  test("a check that throws keeps the session", async () => {
    const { validator } = setup({
      answer: () => Promise.reject(new Error("boom")),
    });
    expect(await validator.ensureValid("1")).toBe(true);
  });

  test("a slow GitHub answers valid in time; a late rejection still drops", async () => {
    let reply: (s: GitHubTokenStatus) => void = () => {};
    const { validator, tokens } = setup({
      answer: () => new Promise((r) => (reply = r)),
    });
    expect(await validator.ensureValid("1")).toBe(true);
    reply("revoked");
    await Bun.sleep(0);
    expect(tokens["1"]).toBeUndefined();
  });

  test("concurrent checks share one GitHub call", async () => {
    let reply: (s: GitHubTokenStatus) => void = () => {};
    const { validator, asked } = setup({
      answer: () => new Promise((r) => (reply = r)),
    });
    const a = validator.ensureValid("1");
    const b = validator.ensureValid("1");
    reply("valid");
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(asked).toHaveLength(1);
  });

  test("a login that replaced the token during the check keeps the session", async () => {
    let reply: (s: GitHubTokenStatus) => void = () => {};
    const { validator, tokens } = setup({
      answer: () => new Promise((r) => (reply = r)),
    });
    const pending = validator.ensureValid("1");
    tokens["1"] = "gho_b";
    reply("revoked");
    expect(await pending).toBe(true);
    expect(tokens["1"]).toBe("gho_b");
  });

  test("an auth-bypassed server never asks nor drops", async () => {
    const { validator, asked, tokens } = setup({
      answer: async () => "revoked",
      bypassed: true,
    });
    expect(await validator.ensureValid("1")).toBe(true);
    validator.rejected("1", "gho_a");
    expect(asked).toEqual([]);
    expect(tokens["1"]).toBe("gho_a");
  });
});

describe("GitHubTokenValidator.rejected", () => {
  test("drops the token and forgets that it was accepted", async () => {
    const { validator, tokens, asked } = setup();
    await validator.ensureValid("1");
    validator.rejected("1", "gho_a");
    expect(tokens["1"]).toBeUndefined();
    tokens["1"] = "gho_a"; // same token stored again: asked again
    await validator.ensureValid("1");
    expect(asked).toHaveLength(2);
  });

  test("an older token never drops a newer login's", () => {
    const { validator, tokens } = setup();
    validator.rejected("1", "gho_old");
    expect(tokens["1"]).toBe("gho_a");
  });
});
