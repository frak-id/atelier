import { describe, expect, test } from "bun:test";
import { GitHubError, sendWithRetries } from "./github.ts";

/** A request that fails with each of `errors` in turn, then answers "ok". */
function failing(...errors: Error[]) {
  const calls = { count: 0 };
  const send = async () => {
    const error = errors[calls.count++];
    if (error) throw error;
    return "ok";
  };
  return { calls, send };
}

const noWait = async () => {};
const quietLog = () => {};

describe("a GitHub request", () => {
  test("waits out a rate limit, whatever its method", async () => {
    const { calls, send } = failing(
      new GitHubError("limited", 403, 1_000),
      new GitHubError("limited", 429, 1_000),
    );
    expect(await sendWithRetries("POST x", send, [], quietLog, noWait)).toBe(
      "ok",
    );
    expect(calls.count).toBe(3);
  });

  test("is sent again after a server or network error, only with delays", async () => {
    const server = failing(
      new GitHubError("bad gateway", 502),
      new Error("socket"),
    );
    expect(
      await sendWithRetries("GET x", server.send, [1, 1], quietLog, noWait),
    ).toBe("ok");
    const post = failing(new GitHubError("bad gateway", 502));
    await expect(
      sendWithRetries("POST x", post.send, [], quietLog, noWait),
    ).rejects.toThrow("bad gateway");
    expect(post.calls.count).toBe(1);
  });

  test("fails at once on a refusal, and past the delays", async () => {
    const refused = failing(new GitHubError("not found", 404));
    await expect(
      sendWithRetries("GET x", refused.send, [1, 1], quietLog, noWait),
    ).rejects.toThrow("not found");
    expect(refused.calls.count).toBe(1);
    const down = failing(
      new GitHubError("down", 503),
      new GitHubError("down", 503),
      new GitHubError("down", 503),
    );
    await expect(
      sendWithRetries("GET x", down.send, [1, 1], quietLog, noWait),
    ).rejects.toThrow("down");
    expect(down.calls.count).toBe(3);
  });

  test("fails on a rate limit too long to wait, or past three waits", async () => {
    const long = failing(new GitHubError("limited", 403, 60 * 60_000));
    await expect(
      sendWithRetries("GET x", long.send, [], quietLog, noWait),
    ).rejects.toThrow("limited");
    const often = failing(
      ...Array.from(
        { length: 4 },
        () => new GitHubError("limited", 429, 1_000),
      ),
    );
    await expect(
      sendWithRetries("GET x", often.send, [], quietLog, noWait),
    ).rejects.toThrow("limited");
    expect(often.calls.count).toBe(4);
  });
});
