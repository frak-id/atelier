import { describe, expect, test } from "bun:test";
import {
  createPublicKey,
  createVerify,
  generateKeyPairSync,
} from "node:crypto";
import {
  GitHubAppClient,
  GitHubAppError,
  intersectPermissions,
  signAppJwt,
} from "./github-app.ts";

const { privateKey: pkcs8, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
// GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY").
const pkcs1 = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const NOW = 1_800_000_000_000;

function decode(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString());
}

describe("signAppJwt", () => {
  test("is RS256 with the App's claims, verifiable with the public key", () => {
    const jwt = signAppJwt("123", pkcs8, NOW);
    const [header, payload, signature] = jwt.split(".") as [
      string,
      string,
      string,
    ];
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(payload)).toEqual({
      iat: NOW / 1000 - 60,
      exp: NOW / 1000 + 540,
      iss: "123",
    });
    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(createPublicKey(publicKey), Buffer.from(signature, "base64url"));
    expect(ok).toBe(true);
  });

  test("accepts a PKCS#1 key", () => {
    const jwt = signAppJwt("123", pkcs1.privateKey, NOW);
    const [header, payload, signature] = jwt.split(".") as [
      string,
      string,
      string,
    ];
    expect(
      createVerify("RSA-SHA256")
        .update(`${header}.${payload}`)
        .verify(
          createPublicKey(pkcs1.publicKey),
          Buffer.from(signature, "base64url"),
        ),
    ).toBe(true);
  });

  test("a bad key fails without quoting it", () => {
    const bad = "-----BEGIN RSA PRIVATE KEY-----\nSECRETBITS\n-----END";
    try {
      signAppJwt("123", bad, NOW);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubAppError);
      expect((err as Error).message).not.toContain("SECRETBITS");
    }
  });
});

describe("intersectPermissions", () => {
  test("caps write to what was granted and drops what wasn't", () => {
    expect(
      intersectPermissions(
        {
          contents: "write",
          pull_requests: "write",
          workflows: "write",
          metadata: "read",
        },
        { contents: "write", pull_requests: "read", metadata: "read" },
      ),
    ).toEqual({ contents: "write", pull_requests: "read", metadata: "read" });
  });

  test("read wanted stays read when write is granted", () => {
    expect(
      intersectPermissions({ contents: "read" }, { contents: "write" }),
    ).toEqual({ contents: "read" });
  });
});

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body?: unknown;
}

function fakeGitHub(
  opts: {
    granted?: Record<string, string>;
    tokenStatus?: number;
    /** Statuses for the first token requests, in order. */
    tokenStatuses?: number[];
    noExpiry?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  const signals: Array<AbortSignal | null | undefined> = [];
  let clock = NOW;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    signals.push(init?.signal);
    calls.push({
      url,
      method: init?.method ?? "GET",
      auth: headers.get("Authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const path = url.replace("https://api.github.com", "");
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status });
    if (path === "/app/installations/77") {
      return json({
        permissions: opts.granted ?? { contents: "write", metadata: "read" },
      });
    }
    if (path === "/app/installations/77/access_tokens") {
      const status = opts.tokenStatuses?.shift() ?? opts.tokenStatus;
      if (status) return json({ message: "Bad credentials" }, status);
      return json({
        token: "ghs_minted",
        ...(opts.noExpiry
          ? {}
          : { expires_at: new Date(NOW + 3600_000).toISOString() }),
        permissions: { contents: "write", metadata: "read" },
        repositories: [{ name: "flow" }],
      });
    }
    if (path === "/app") return json({ slug: "daedalus" });
    if (path === "/users/daedalus%5Bbot%5D") return json({ id: 4242 });
    return json({ message: "Not Found" }, 404);
  };
  return {
    calls,
    signals,
    advance: (ms: number) => {
      clock += ms;
    },
    client: new GitHubAppClient({ fetch: fetchImpl, now: () => clock }),
  };
}

const creds = { appId: "123", installationId: "77", privateKey: pkcs8 };

describe("GitHubAppClient.mintInstallationToken", () => {
  test("requests the intersection of wanted and granted, as the App", async () => {
    const { client, calls } = fakeGitHub();
    const minted = await client.mintInstallationToken({
      ...creds,
      repositories: ["flow"],
    });
    expect(minted).toEqual({
      token: "ghs_minted",
      expiresAt: NOW + 3600_000,
      permissions: { contents: "write", metadata: "read" },
      repositories: ["flow"],
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/app/installations/77",
      "POST https://api.github.com/app/installations/77/access_tokens",
    ]);
    expect(calls[0]?.auth).toStartWith("Bearer ey");
    // Defaults asked for pull_requests/workflows too: dropped, not granted.
    expect(calls[1]?.body).toEqual({
      permissions: { contents: "write", metadata: "read" },
      repositories: ["flow"],
    });
  });

  test("configured permissions replace the defaults", async () => {
    const { client, calls } = fakeGitHub();
    await client.mintInstallationToken({
      ...creds,
      permissions: { contents: "read" },
    });
    expect(calls[1]?.body).toEqual({ permissions: { contents: "read" } });
  });

  test("granted permissions are cached for ~10 minutes", async () => {
    const { client, calls, advance } = fakeGitHub();
    await client.mintInstallationToken(creds);
    await client.mintInstallationToken(creds);
    expect(
      calls.filter((c) => c.url.endsWith("/installations/77")),
    ).toHaveLength(1);
    advance(11 * 60 * 1000);
    await client.mintInstallationToken(creds);
    expect(
      calls.filter((c) => c.url.endsWith("/installations/77")),
    ).toHaveLength(2);
  });

  test("nothing in common is an error, not an everything-token", async () => {
    const { client } = fakeGitHub({ granted: { issues: "write" } });
    await expect(client.mintInstallationToken(creds)).rejects.toThrow(
      GitHubAppError,
    );
  });

  test("a GitHub error carries status and message, no secret", async () => {
    const { client } = fakeGitHub({ tokenStatus: 401 });
    try {
      await client.mintInstallationToken(creds);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubAppError);
      const e = err as GitHubAppError;
      expect(e.status).toBe(401);
      expect(e.message).toContain("Bad credentials");
      expect(e.message).not.toContain("PRIVATE KEY");
      expect(e.message).not.toContain("ey");
    }
  });

  test("every call carries a timeout signal", async () => {
    const { client, signals } = fakeGitHub();
    await client.mintInstallationToken(creds);
    await client.botIdentity(creds);
    expect(signals).toHaveLength(4);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  test("a timeout is a typed error with status 0 and a clear message", async () => {
    const client = new GitHubAppClient({
      fetch: async () => {
        throw new DOMException("timed out", "TimeoutError");
      },
    });
    const err = await client.mintInstallationToken(creds).catch((e) => e);
    expect(err).toBeInstanceOf(GitHubAppError);
    expect(err.status).toBe(0);
    expect(err.message).toContain("timed out");
  });

  test("a 422 drops the remembered permissions, so the retry looks them up again", async () => {
    const { client, calls } = fakeGitHub({ tokenStatuses: [422] });
    await expect(client.mintInstallationToken(creds)).rejects.toMatchObject({
      status: 422,
    });
    const minted = await client.mintInstallationToken(creds);
    expect(minted.token).toBe("ghs_minted");
    expect(
      calls.filter((c) => c.url.endsWith("/installations/77")),
    ).toHaveLength(2);
  });

  test("fresh ignores the remembered permissions", async () => {
    const { client, calls } = fakeGitHub();
    await client.mintInstallationToken(creds);
    await client.mintInstallationToken(creds, { fresh: true });
    expect(
      calls.filter((c) => c.url.endsWith("/installations/77")),
    ).toHaveLength(2);
  });

  test("a response without expires_at is refused", async () => {
    const { client } = fakeGitHub({ noExpiry: true });
    await expect(client.mintInstallationToken(creds)).rejects.toThrow(
      "no valid expiry",
    );
  });

  test("an empty repositories list is not sent", async () => {
    const { client, calls } = fakeGitHub();
    await client.mintInstallationToken({ ...creds, repositories: [] });
    expect(calls[1]?.body).toEqual({
      permissions: { contents: "write", metadata: "read" },
    });
  });

  test("a network failure is a typed error with status 0", async () => {
    const client = new GitHubAppClient({
      fetch: async () => {
        throw new Error("socket with Bearer sekret");
      },
    });
    try {
      await client.mintInstallationToken(creds);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GitHubAppError);
      expect((err as Error).message).not.toContain("sekret");
    }
  });
});

describe("GitHubAppClient.botIdentity", () => {
  test("is <slug>[bot] with the noreply email, cached per App", async () => {
    const { client, calls } = fakeGitHub();
    const identity = await client.botIdentity(creds);
    expect(identity).toEqual({
      name: "daedalus[bot]",
      email: "4242+daedalus[bot]@users.noreply.github.com",
    });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/app",
      "https://api.github.com/users/daedalus%5Bbot%5D",
    ]);
    await client.botIdentity(creds);
    expect(calls).toHaveLength(2);
  });

  test("the bot user lookup is public: no App JWT", async () => {
    const { client, calls } = fakeGitHub();
    await client.botIdentity(creds);
    expect(calls[0]?.auth).toStartWith("Bearer ey");
    expect(calls[1]?.auth).toBeNull();
  });
});

describe("GitHubAppClient.revokeInstallationToken", () => {
  test("DELETEs /installation/token as the token, and never throws", async () => {
    const calls: Array<{ url: string; method?: string; auth: string | null }> =
      [];
    const client = new GitHubAppClient({
      fetch: async (url, init) => {
        calls.push({
          url,
          method: init?.method,
          auth: new Headers(init?.headers).get("Authorization"),
        });
        return new Response(null, { status: 204 });
      },
    });
    await client.revokeInstallationToken("ghs_x");
    expect(calls).toEqual([
      {
        url: "https://api.github.com/installation/token",
        method: "DELETE",
        auth: "Bearer ghs_x",
      },
    ]);
    const failing = new GitHubAppClient({
      fetch: async () => {
        throw new Error("down");
      },
    });
    await failing.revokeInstallationToken("ghs_x");
  });
});
