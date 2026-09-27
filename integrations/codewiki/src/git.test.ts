import { describe, expect, test } from "bun:test";
import type { RepoRef } from "./config.ts";
import {
  fetchBranch,
  type GitRunner,
  type GitRunOptions,
  remoteHeadSha,
} from "./git.ts";

const ref: RepoRef = { owner: "frak-id", repo: "atelier", branch: "main" };

function fakeRunner(
  handler: (args: string[], opts?: GitRunOptions) => Promise<string> | string,
): { runner: GitRunner; calls: { args: string[]; opts?: GitRunOptions }[] } {
  const calls: { args: string[]; opts?: GitRunOptions }[] = [];
  return {
    runner: {
      async run(args, opts) {
        calls.push({ args, opts });
        return handler(args, opts);
      },
    },
    calls,
  };
}

describe("remoteHeadSha", () => {
  test("never puts the token in argv — only the x-access-token username", async () => {
    const { runner, calls } = fakeRunner(() => "abc123\trefs/heads/main");
    const sha = await remoteHeadSha(ref, "ghp_secret", runner);
    expect(sha).toBe("abc123");
    expect(calls[0]?.args).toEqual([
      "ls-remote",
      "https://x-access-token@github.com/frak-id/atelier.git",
      "refs/heads/main",
    ]);
    for (const call of calls) {
      for (const arg of call.args) {
        expect(arg).not.toContain("ghp_secret");
      }
    }
  });

  test("supplies the token via GIT_ASKPASS env, not the URL", async () => {
    const { runner, calls } = fakeRunner(() => "abc123\trefs/heads/main");
    await remoteHeadSha(ref, "ghp_secret", runner);
    const env = calls[0]?.opts?.env;
    expect(env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env?.GIT_ASKPASS).toBeTruthy();
    expect(env?.CODEWIKI_GIT_ASKPASS_TOKEN).toBe("ghp_secret");
  });

  test("uses an unauthenticated URL and no askpass when no token is given", async () => {
    const { runner, calls } = fakeRunner(() => "abc123\trefs/heads/main");
    await remoteHeadSha(ref, undefined, runner);
    expect(calls[0]?.args[1]).toBe("https://github.com/frak-id/atelier.git");
    expect(calls[0]?.opts?.env?.GIT_ASKPASS).toBeUndefined();
    expect(calls[0]?.opts?.env?.GIT_TERMINAL_PROMPT).toBe("0");
  });

  test("redacts the token from a thrown error", async () => {
    const { runner } = fakeRunner(() => {
      throw new Error("auth failed for ghp_secret");
    });
    const promise = remoteHeadSha(ref, "ghp_secret", runner);
    await expect(promise).rejects.toThrow();
    try {
      await promise;
    } catch (err) {
      expect(String(err)).not.toContain("ghp_secret");
    }
  });

  test("throws when the branch has no matching ref", async () => {
    const { runner } = fakeRunner(() => "");
    await expect(remoteHeadSha(ref, undefined, runner)).rejects.toThrow(
      /not found/,
    );
  });
});

describe("fetchBranch", () => {
  test("runs init, fetch (unauthed URL), checkout, rev-parse in order", async () => {
    const { runner, calls } = fakeRunner((args) =>
      args[0] === "rev-parse" ? "deadbeef" : "",
    );
    const sha = await fetchBranch(ref, "/tmp/checkout", "ghp_secret", runner);
    expect(sha).toBe("deadbeef");
    expect(calls.map((c) => c.args[0])).toEqual([
      "init",
      "fetch",
      "checkout",
      "rev-parse",
    ]);
    const fetchCall = calls.find((c) => c.args[0] === "fetch");
    expect(fetchCall?.args).toContain(
      "https://x-access-token@github.com/frak-id/atelier.git",
    );
    expect(fetchCall?.opts?.cwd).toBe("/tmp/checkout");
    for (const call of calls) {
      for (const arg of call.args) {
        expect(arg).not.toContain("ghp_secret");
      }
    }
  });

  test("every git invocation gets the same askpass env", async () => {
    const { runner, calls } = fakeRunner((args) =>
      args[0] === "rev-parse" ? "deadbeef" : "",
    );
    await fetchBranch(ref, "/tmp/checkout", "ghp_secret", runner);
    for (const call of calls) {
      expect(call.opts?.env?.GIT_ASKPASS).toBeTruthy();
      expect(call.opts?.env?.CODEWIKI_GIT_ASKPASS_TOKEN).toBe("ghp_secret");
    }
  });

  test("redacts the token from a thrown error", async () => {
    const { runner } = fakeRunner((args) => {
      if (args[0] === "fetch") throw new Error("denied: ghp_secret");
      return "";
    });
    const promise = fetchBranch(ref, "/tmp/checkout", "ghp_secret", runner);
    await expect(promise).rejects.toThrow();
    try {
      await promise;
    } catch (err) {
      expect(String(err)).not.toContain("ghp_secret");
    }
  });
});
