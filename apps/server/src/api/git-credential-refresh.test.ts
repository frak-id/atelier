import { describe, expect, test } from "bun:test";
import {
  GIT_CREDENTIALS_PATH,
  GITCONFIG_PATH,
} from "../shared/lib/git-attribution.ts";
import { GitCredentialRefresher } from "./git-credential-refresh.ts";

type Sandbox = {
  id: string;
  status: string;
  metadata?: Record<string, string>;
};

const sandbox = (id: string, owner: string, status = "running"): Sandbox => ({
  id,
  status,
  metadata: { "atelier.dev/owner-id": owner },
});

function setup(initial: Sandbox[]) {
  let sandboxes = initial;
  const tokens: Record<string, string | undefined> = {
    sa_a: "ghs_1",
    "1234": "gho_1",
  };
  /** Resolves of this owner read the credential, then wait for a
   * `release()` before returning it (a slow resolve). */
  let held: { owner: string; release: Array<() => void> } | undefined;
  /** Accounts with no credential at all (as opposed to a failed mint). */
  const uncredentialed = new Set<string>();
  const botNames: Record<string, string> = {};
  const writes: Array<{ id: string; files: unknown[] }> = [];
  let failFor: string | undefined;
  const refresher = new GitCredentialRefresher({
    runtime: {
      list: () => sandboxes as never,
      writeFilesQuietly: async (id: string, files: unknown[]) => {
        if (id === failFor) throw new Error("agent down");
        writes.push({ id, files });
        return { results: [{ path: GIT_CREDENTIALS_PATH, success: true }] };
      },
    } as never,
    credentials: {
      resolve: async (id: string) => {
        const credential = credentialOf(id);
        if (held?.owner === id) {
          const gate = held;
          await new Promise<void>((r) => gate.release.push(r));
        }
        return credential;
      },
    },
  });
  const credentialOf = (id: string) => ({
    identity: {
      name: botNames[id] ?? "app[bot]",
      email: "1+app[bot]@users.noreply.github.com",
    },
    ...(tokens[id] ? { token: tokens[id] } : {}),
    ...(uncredentialed.has(id) ? { noCredential: true as const } : {}),
  });
  return {
    refresher,
    hold: (owner: string) => {
      held = { owner, release: [] };
      return held.release;
    },
    writes,
    tokens,
    botNames,
    uncredentialed,
    setSandboxes: (s: Sandbox[]) => {
      sandboxes = s;
    },
    failFor: (id: string) => {
      failFor = id;
    },
  };
}

describe("GitCredentialRefresher", () => {
  test("an edited git identity on an unchanged token is written", async () => {
    const { refresher, writes, botNames } = setup([sandbox("s1", "sa_a")]);
    await refresher.tick();
    await refresher.tick();
    expect(writes).toHaveLength(1);
    botNames.sa_a = "renamed[bot]";
    await refresher.tick();
    expect(writes).toHaveLength(2);
  });

  test("writes the git files of running sandboxes that have an owner", async () => {
    const { refresher, writes } = setup([
      sandbox("s1", "sa_a"),
      sandbox("s2", "sa_a", "paused"),
      sandbox("s3", "1234"),
      { id: "s4", status: "running" },
    ]);
    await refresher.tick();
    expect(writes.map((w) => w.id).sort()).toEqual(["s1", "s3"]);
    expect(writes.find((w) => w.id === "s3")?.files).toContainEqual({
      path: GIT_CREDENTIALS_PATH,
      content: "https://x-access-token:gho_1@github.com\n",
      mode: "0600",
      owner: "dev",
    });
    writes.sort((a, b) => a.id.localeCompare(b.id));
    expect(writes[0]?.files).toEqual([
      {
        path: GITCONFIG_PATH,
        content: expect.stringContaining("helper = store") as unknown as string,
        owner: "root",
      },
      {
        path: GIT_CREDENTIALS_PATH,
        content: "https://x-access-token:ghs_1@github.com\n",
        mode: "0600",
        owner: "dev",
      },
    ]);
  });

  test("skips an unchanged token, rewrites a changed one", async () => {
    const { refresher, writes, tokens } = setup([sandbox("s1", "sa_a")]);
    await refresher.tick();
    await refresher.tick();
    expect(writes).toHaveLength(1);
    tokens.sa_a = "ghs_2";
    await refresher.tick();
    expect(writes).toHaveLength(2);
  });

  test("a failed mint keeps the last token in place", async () => {
    const { refresher, writes, tokens } = setup([sandbox("s1", "sa_a")]);
    await refresher.tick();
    tokens.sa_a = undefined;
    await refresher.tick();
    expect(writes).toHaveLength(1);
  });

  test("a removed credential empties the credential file, once", async () => {
    const { refresher, writes, tokens, uncredentialed } = setup([
      sandbox("s1", "sa_a"),
    ]);
    await refresher.tick();
    tokens.sa_a = undefined;
    uncredentialed.add("sa_a");
    await refresher.tick();
    await refresher.tick();
    expect(writes).toHaveLength(2);
    expect(writes[1]?.files).toEqual([
      { path: GIT_CREDENTIALS_PATH, content: "", mode: "0600", owner: "dev" },
    ]);
  });

  test("forgets a sandbox that stopped running, so a resume is rewritten", async () => {
    const { refresher, writes, setSandboxes } = setup([sandbox("s1", "sa_a")]);
    await refresher.tick();
    setSandboxes([sandbox("s1", "sa_a", "paused")]);
    await refresher.tick();
    setSandboxes([sandbox("s1", "sa_a")]);
    await refresher.tick();
    expect(writes).toHaveLength(2);
  });

  test("a person's new login token reaches their running sandboxes only", async () => {
    const { refresher, writes, tokens } = setup([
      sandbox("s1", "1234"),
      sandbox("s2", "1234", "paused"),
      sandbox("s3", "sa_a"),
    ]);
    await refresher.tick();
    writes.length = 0;
    tokens["1234"] = "gho_2";
    await refresher.refreshOwner("1234");
    expect(writes.map((w) => w.id)).toEqual(["s1"]);
    expect(writes[0]?.files).toContainEqual(
      expect.objectContaining({
        content: "https://x-access-token:gho_2@github.com\n",
      }),
    );
    // The next tick finds nothing new to write.
    await refresher.tick();
    expect(writes).toHaveLength(1);
  });

  test("a person whose token was dropped keeps the last one written", async () => {
    const { refresher, writes, tokens } = setup([sandbox("s1", "1234")]);
    await refresher.tick();
    tokens["1234"] = undefined;
    await refresher.tick();
    expect(writes).toHaveLength(1);
  });

  test("writes to one sandbox run in order, the last with the newest token", async () => {
    const { refresher, writes, tokens, hold } = setup([sandbox("s1", "1234")]);
    const release = hold("1234");
    // A tick starts first and stalls; a login lands meanwhile.
    const tick = refresher.tick();
    await Bun.sleep(0);
    tokens["1234"] = "gho_2";
    const login = refresher.refreshOwner("1234");
    await Bun.sleep(0);
    expect(release).toHaveLength(1); // the login waits for the tick
    release.shift()?.();
    await Bun.sleep(0);
    release.shift()?.();
    await Promise.all([tick, login]);
    const contents = writes.map(
      (w) => (w.files as Array<{ content: string }>)[1]?.content,
    );
    expect(contents).toEqual([
      "https://x-access-token:gho_1@github.com\n",
      "https://x-access-token:gho_2@github.com\n",
    ]);
  });

  test("one sandbox failing does not stop the others, and is retried", async () => {
    const { refresher, writes, failFor } = setup([
      sandbox("s1", "sa_a"),
      sandbox("s2", "sa_a"),
    ]);
    failFor("s1");
    await refresher.tick();
    expect(writes.map((w) => w.id)).toEqual(["s2"]);
    failFor("none");
    await refresher.tick();
    expect(writes.map((w) => w.id)).toEqual(["s2", "s1"]);
  });
});
