import { describe, expect, test } from "bun:test";
import type { RepoRef } from "./config.ts";
import { fetchBranch, type GitRunner, remoteHeadSha } from "./git.ts";

const ref: RepoRef = { owner: "frak-id", repo: "atelier", branch: "main" };

function fakeRunner(
  handler: (args: string[], cwd?: string) => Promise<string> | string,
): { runner: GitRunner; calls: { args: string[]; cwd?: string }[] } {
  const calls: { args: string[]; cwd?: string }[] = [];
  return {
    runner: {
      async run(args, cwd) {
        calls.push({ args, cwd });
        return handler(args, cwd);
      },
    },
    calls,
  };
}

describe("remoteHeadSha", () => {
  test("passes an authed URL as an argv value and parses the sha", async () => {
    const { runner, calls } = fakeRunner(() => "abc123\trefs/heads/main");
    const sha = await remoteHeadSha(ref, "ghp_secret", runner);
    expect(sha).toBe("abc123");
    expect(calls[0]?.args).toEqual([
      "ls-remote",
      "https://x-access-token:ghp_secret@github.com/frak-id/atelier.git",
      "refs/heads/main",
    ]);
  });

  test("uses an unauthenticated URL when no token is given", async () => {
    const { runner, calls } = fakeRunner(() => "abc123\trefs/heads/main");
    await remoteHeadSha(ref, undefined, runner);
    expect(calls[0]?.args[1]).toBe("https://github.com/frak-id/atelier.git");
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
  test("runs init, fetch (authed URL), checkout, rev-parse in order", async () => {
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
      "https://x-access-token:ghp_secret@github.com/frak-id/atelier.git",
    );
    expect(fetchCall?.cwd).toBe("/tmp/checkout");
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
