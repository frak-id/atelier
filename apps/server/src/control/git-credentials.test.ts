/**
 * `GitCredentialService`: a person keeps today's behaviour, a service account
 * only ever gets its own credential (never a person's or the host's token,
 * local mode included), and an App token is cached until 15 minutes before it
 * expires.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

// Local mode, set before anything loads the server config.
process.env.ATELIER_SERVER_MODE = "local";

const { useTestDatabase } = await import("../runtime/test-database.ts");
const { GitCredentialService } = await import("./git-credentials.ts");
const { GitHubAppError } = await import("./github-app.ts");
const { ServiceAccountRepository } = await import(
  "./modules/service-account/index.ts"
);
const { UserRepository, UserService } = await import("./modules/user/index.ts");

beforeEach(() => useTestDatabase());

const pem = () =>
  generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;

const BOT = {
  name: "daedalus[bot]",
  email: "4242+daedalus[bot]@users.noreply.github.com",
};

function setup() {
  const users = new UserService(new UserRepository());
  const serviceAccounts = new ServiceAccountRepository();
  let now = 1_800_000_000_000;
  let mints = 0;
  let failMint = false;
  let mintDelay: Promise<void> = Promise.resolve();
  const freshMints: Array<boolean | undefined> = [];
  const revoked: string[] = [];
  const app = {
    revokeInstallationToken: async (token: string) => {
      revoked.push(token);
    },
    mintInstallationToken: async (
      _creds: unknown,
      opts?: { fresh?: boolean },
    ) => {
      mints++;
      freshMints.push(opts?.fresh);
      await mintDelay;
      if (failMint)
        throw new GitHubAppError("GitHub token request failed", 500);
      return {
        token: `ghs_${mints}`,
        expiresAt: now + 3600_000,
        permissions: { contents: "write" as const },
        repositories: ["flow"],
      };
    },
    botIdentity: async () => BOT,
  };
  const service = new GitCredentialService({
    users,
    serviceAccounts,
    app,
    now: () => now,
  });
  const createSa = (
    name: string,
    github?: Parameters<typeof serviceAccounts.create>[0]["github"],
  ) =>
    serviceAccounts.create({
      id: `sa_${name}`,
      name,
      username: `${name}[bot]`,
      email: `${name}@service-accounts.invalid`,
      description: "",
      orgId: "org-1",
      managedBy: "console",
      github,
    });
  return {
    users,
    service,
    serviceAccounts,
    createSa,
    mints: () => mints,
    freshMints,
    revoked,
    advance: (ms: number) => {
      now += ms;
    },
    failMints: (v: boolean) => {
      failMint = v;
    },
    delayMints: (p: Promise<void>) => {
      mintDelay = p;
    },
  };
}

const appCreds = (privateKey = pem()) => ({
  kind: "app" as const,
  appId: "123",
  installationId: "77",
  privateKey,
});

afterEach(() => {
  delete process.env.ATELIER_GITHUB_TOKEN;
});

describe("GitCredentialService.resolve", () => {
  test("an unknown user resolves to nothing", async () => {
    expect(await setup().service.resolve("ghost")).toEqual({});
  });

  test("a person gets the token UserService resolves, and their identity", async () => {
    // Local mode: the host's token (a stored OAuth token is a placeholder).
    process.env.ATELIER_GITHUB_TOKEN = "gho_host";
    const { users, service } = setup();
    users.upsertFromLogin("1", "alice", "alice@x.test", "", "gho_alice");
    expect(await service.resolve("1")).toEqual({
      token: "gho_host",
      identity: { name: "alice", email: "alice@x.test" },
    });
  });

  test("a service account never gets the host token in local mode", async () => {
    process.env.ATELIER_GITHUB_TOKEN = "gho_host";
    const { users, service, createSa } = setup();
    createSa("plain");
    createSa("bot", appCreds());
    users.upsertFromLogin("1", "alice", "alice@x.test", "", "gho_alice");
    expect((await service.resolve("sa_plain")).token).toBeUndefined();
    // A person in local mode still gets the host's token.
    expect((await service.resolve("1")).token).toBe("gho_host");
  });

  test("a service account without a credential has an identity and no token", async () => {
    const { service, createSa } = setup();
    createSa("plain");
    expect(await service.resolve("sa_plain")).toEqual({
      identity: { name: "plain[bot]", email: "plain@service-accounts.invalid" },
      noCredential: true,
    });
  });

  test("a static token comes with its own git identity", async () => {
    const { service, createSa } = setup();
    createSa("tok", {
      kind: "token",
      token: "ghp_static",
      gitName: "CI Bot",
      gitEmail: "ci@x.test",
    });
    expect(await service.resolve("sa_tok")).toEqual({
      token: "ghp_static",
      identity: { name: "CI Bot", email: "ci@x.test" },
    });
  });

  test("an App service account gets an installation token and the bot identity", async () => {
    const { service, createSa } = setup();
    createSa("daedalus", appCreds());
    const resolved = await service.resolve("sa_daedalus");
    expect(resolved.token).toBe("ghs_1");
    expect(resolved.identity).toEqual(BOT);
    expect(resolved.expiresAt).toBeGreaterThan(0);
  });
});

describe("App token cache", () => {
  test("is reused until 15 minutes before expiry, then re-minted", async () => {
    const { service, createSa, mints, advance } = setup();
    createSa("daedalus", appCreds());
    await service.resolve("sa_daedalus");
    advance(40 * 60 * 1000);
    expect((await service.resolve("sa_daedalus")).token).toBe("ghs_1");
    expect(mints()).toBe(1);
    // 46 min in: 14 min remain.
    advance(6 * 60 * 1000);
    expect((await service.resolve("sa_daedalus")).token).toBe("ghs_2");
    expect(mints()).toBe(2);
  });

  test("an edited credential re-mints", async () => {
    const { service, createSa, serviceAccounts, mints } = setup();
    createSa("daedalus", appCreds());
    await service.resolve("sa_daedalus");
    serviceAccounts.setGitHub("sa_daedalus", appCreds());
    await service.resolve("sa_daedalus");
    expect(mints()).toBe(2);
  });

  test("concurrent resolves share one mint", async () => {
    const { service, createSa, mints, delayMints } = setup();
    createSa("daedalus", appCreds());
    let release = () => {};
    delayMints(new Promise<void>((r) => (release = r)));
    const all = Promise.all([
      service.resolve("sa_daedalus"),
      service.resolve("sa_daedalus"),
      service.resolve("sa_daedalus"),
    ]);
    // Let the three calls reach the mint before it completes.
    await new Promise((r) => setTimeout(r, 0));
    release();
    const results = await all;
    expect(mints()).toBe(1);
    expect(new Set(results.map((r) => r.token))).toEqual(new Set(["ghs_1"]));
  });

  test("a mint failure keeps the identity, drops the token, and borrows none", async () => {
    process.env.ATELIER_GITHUB_TOKEN = "gho_host";
    const { users, service, createSa, failMints } = setup();
    users.upsertFromLogin("1", "alice", "alice@x.test", "", "gho_alice");
    createSa("daedalus", appCreds());
    failMints(true);
    expect(await service.resolve("sa_daedalus")).toEqual({ identity: BOT });
  });

  test("a failed mint is not cached: the next resolve retries", async () => {
    const { service, createSa, failMints, mints } = setup();
    createSa("daedalus", appCreds());
    failMints(true);
    await service.resolve("sa_daedalus");
    failMints(false);
    expect((await service.resolve("sa_daedalus")).token).toBe("ghs_2");
    expect(mints()).toBe(2);
  });
});

describe("GitCredentialService.token and check", () => {
  test("token is resolve's token", async () => {
    const { service, createSa } = setup();
    createSa("daedalus", appCreds());
    expect(await service.token("sa_daedalus")).toBe("ghs_1");
  });

  test("check mints fresh, then the result is what resolve serves", async () => {
    const { service, createSa, mints } = setup();
    createSa("daedalus", appCreds());
    await service.resolve("sa_daedalus");
    const checked = await service.check("sa_daedalus");
    expect(checked).toMatchObject({
      identity: BOT,
      permissions: { contents: "write" },
      repositories: ["flow"],
    });
    expect(mints()).toBe(2);
    expect((await service.resolve("sa_daedalus")).token).toBe("ghs_2");
    expect(mints()).toBe(2);
  });

  test("check refuses an account without an App credential", async () => {
    const { service, createSa } = setup();
    createSa("plain");
    await expect(service.check("sa_plain")).rejects.toThrow("no GitHub App");
  });

  test("check bypasses the granted-permissions cache", async () => {
    const { service, createSa, freshMints } = setup();
    createSa("daedalus", appCreds());
    await service.resolve("sa_daedalus");
    await service.check("sa_daedalus");
    expect(freshMints).toEqual([undefined, true]);
  });
});

describe("local mode and unreadable secrets", () => {
  test("an unknown non-service id gets the host token; an sa_ id gets nothing", async () => {
    process.env.ATELIER_GITHUB_TOKEN = "gho_host";
    const { service } = setup();
    expect(await service.resolve("12345")).toEqual({ token: "gho_host" });
    expect(await service.resolve("sa_gone")).toEqual({});
  });

  test("an undecryptable secret keeps the identity and is not 'no credential'", async () => {
    const { service, createSa } = setup();
    createSa("daedalus", appCreds());
    const { getDatabase } = await import("./db/client.ts");
    const { serviceAccounts } = await import("./db/schema.ts");
    const { eq } = await import("drizzle-orm");
    getDatabase()
      .update(serviceAccounts)
      .set({ githubSecret: `enc:${Buffer.alloc(40).toString("base64")}` })
      .where(eq(serviceAccounts.userId, "sa_daedalus"))
      .run();
    const resolved = await service.resolve("sa_daedalus");
    expect(resolved).toEqual({
      identity: {
        name: "daedalus[bot]",
        email: "daedalus@service-accounts.invalid",
      },
    });
    expect(resolved.noCredential).toBeUndefined();
    await expect(service.check("sa_daedalus")).rejects.toThrow(
      "can't be decrypted",
    );
  });
});

describe("mint failures and forget", () => {
  test("a failed mint falls back to a cached token with more than 2 minutes left", async () => {
    const { service, createSa, advance, failMints } = setup();
    createSa("daedalus", appCreds());
    await service.resolve("sa_daedalus");
    // 50 min in: 10 min remain, so the next resolve re-mints and fails.
    advance(50 * 60 * 1000);
    failMints(true);
    expect((await service.resolve("sa_daedalus")).token).toBe("ghs_1");
    // 59 min in: under 2 minutes remain, the token is no longer offered.
    advance(9 * 60 * 1000);
    expect((await service.resolve("sa_daedalus")).token).toBeUndefined();
  });

  test("forget drops the cached token, and revokes it on request", async () => {
    const { service, createSa, mints, revoked } = setup();
    createSa("daedalus", appCreds());
    await service.resolve("sa_daedalus");
    await service.forget("sa_daedalus");
    expect(revoked).toEqual([]);
    await service.resolve("sa_daedalus");
    expect(mints()).toBe(2);
    await service.forget("sa_daedalus", { revoke: true });
    expect(revoked).toEqual(["ghs_2"]);
  });

  test("a mint superseded by an edited credential does not overwrite the newer entry", async () => {
    const { service, createSa, serviceAccounts, mints, delayMints } = setup();
    createSa("daedalus", appCreds());
    let release = () => {};
    delayMints(new Promise<void>((r) => (release = r)));
    const first = service.resolve("sa_daedalus");
    await new Promise((r) => setTimeout(r, 0));
    // Edit the credential and resolve again: a second mint, not delayed.
    serviceAccounts.setGitHub("sa_daedalus", appCreds());
    delayMints(Promise.resolve());
    const second = await service.resolve("sa_daedalus");
    release();
    await first;
    expect(mints()).toBe(2);
    expect((await service.resolve("sa_daedalus")).token).toBe(second.token);
    expect(mints()).toBe(2);
  });
});
