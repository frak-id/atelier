/**
 * GitHub App client: an App JWT (RS256), installation access tokens and the
 * bot's git identity. A service account's credential is an App installation,
 * so its sandboxes push as `<slug>[bot]`, never as a person.
 *
 * Fetch and clock are injectable. Errors carry GitHub's status and message
 * only: never the private key, the JWT or a token.
 */
import { createPrivateKey, createSign } from "node:crypto";
import type { GitIdentity } from "../shared/lib/git-attribution.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import {
  type FetchLike,
  GITHUB_TIMEOUT_MS,
  githubApiDelete,
  githubApiGet,
  githubApiGetPublic,
  githubApiPost,
} from "./github-api.ts";

export type PermissionLevel = "read" | "write";
export type AppPermissions = Record<string, PermissionLevel>;

/** What a service account's App credential holds. */
export interface GitHubAppCredentials {
  appId: string;
  installationId: string;
  privateKey: string;
  repositories?: string[];
  permissions?: AppPermissions;
}

export interface InstallationToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
  /** What the token was actually granted. */
  permissions: AppPermissions;
  repositories?: string[];
}

/** Requested when the credential names no permissions. */
export const DEFAULT_APP_PERMISSIONS: AppPermissions = {
  contents: "write",
  pull_requests: "write",
  workflows: "write",
  metadata: "read",
};

const log = createChildLogger("github-app");

/** How long an installation's granted permissions are remembered. */
const GRANTED_CACHE_MS = 10 * 60 * 1000;

/** A failed GitHub call: its HTTP status (0 when none was reached) and
 * message, nothing from the request. */
export class GitHubAppError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubAppError";
  }
}

const base64url = (input: string | Buffer): string =>
  Buffer.from(input).toString("base64url");

/** Sign an App JWT. `createPrivateKey` takes PKCS#1 and PKCS#8 PEM. */
export function signAppJwt(
  appId: string,
  privateKey: string,
  nowMs: number,
): string {
  const now = Math.floor(nowMs / 1000);
  const unsigned = `${base64url(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  )}.${base64url(
    JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }),
  )}`;
  let signature: Buffer;
  try {
    signature = createSign("RSA-SHA256")
      .update(unsigned)
      .sign(createPrivateKey(privateKey));
  } catch {
    // The crypto error can quote key material details: say nothing of it.
    throw new GitHubAppError("The GitHub App private key is not usable", 0);
  }
  return `${unsigned}.${base64url(signature)}`;
}

/** The permissions to request: what is wanted, capped by what the
 * installation granted, so GitHub never answers 422. */
export function intersectPermissions(
  wanted: AppPermissions,
  granted: Record<string, string>,
): AppPermissions {
  const out: AppPermissions = {};
  for (const [key, level] of Object.entries(wanted)) {
    const have = granted[key];
    if (have !== "read" && have !== "write") continue;
    out[key] = level === "write" && have === "write" ? "write" : "read";
  }
  return out;
}

async function githubMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    if (typeof body.message === "string") return body.message;
  } catch {
    // not JSON
  }
  return response.statusText || "no message";
}

export interface GitHubAppClientDeps {
  fetch?: FetchLike;
  now?: () => number;
}

export class GitHubAppClient {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly granted = new Map<
    string,
    { permissions: Record<string, string>; at: number }
  >();
  private readonly identities = new Map<string, GitIdentity>();

  constructor(deps: GitHubAppClientDeps = {}) {
    this.fetchImpl = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  private async call<T>(
    what: string,
    request: () => Promise<Response>,
  ): Promise<T> {
    let response: Response;
    try {
      response = await request();
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new GitHubAppError(
        timedOut
          ? `GitHub ${what} timed out after ${GITHUB_TIMEOUT_MS / 1000}s`
          : `GitHub ${what} failed: unreachable`,
        0,
      );
    }
    if (!response.ok) {
      throw new GitHubAppError(
        `GitHub ${what} failed (${response.status}): ${await githubMessage(response)}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  /** The permissions the installation was granted (cached ~10 minutes). */
  private async grantedPermissions(
    jwt: string,
    installationId: string,
  ): Promise<Record<string, string>> {
    const cached = this.granted.get(installationId);
    if (cached && this.now() - cached.at < GRANTED_CACHE_MS) {
      return cached.permissions;
    }
    const body = await this.call<{ permissions?: Record<string, string> }>(
      "installation lookup",
      () =>
        githubApiGet(
          jwt,
          `/app/installations/${installationId}`,
          this.fetchImpl,
        ),
    );
    const permissions = body.permissions ?? {};
    this.granted.set(installationId, { permissions, at: this.now() });
    return permissions;
  }

  /** A fresh installation token, narrowed to the credential's repositories
   * and permissions. */
  async mintInstallationToken(
    creds: GitHubAppCredentials,
    opts: { fresh?: boolean } = {},
  ): Promise<InstallationToken> {
    // `fresh` ignores the remembered permissions (Test connection).
    if (opts.fresh) this.granted.delete(creds.installationId);
    const jwt = signAppJwt(creds.appId, creds.privateKey, this.now());
    const granted = await this.grantedPermissions(jwt, creds.installationId);
    const permissions = intersectPermissions(
      creds.permissions ?? DEFAULT_APP_PERMISSIONS,
      granted,
    );
    // An empty set would make GitHub grant everything the installation has.
    if (Object.keys(permissions).length === 0) {
      throw new GitHubAppError(
        "None of the requested permissions is granted to the installation",
        0,
      );
    }
    let body: {
      token: string;
      expires_at: string;
      permissions?: AppPermissions;
      repositories?: Array<{ name: string }>;
    };
    try {
      body = await this.call<typeof body>("token request", () =>
        githubApiPost(
          jwt,
          `/app/installations/${creds.installationId}/access_tokens`,
          {
            permissions,
            ...(creds.repositories?.length
              ? { repositories: creds.repositories }
              : {}),
          },
          this.fetchImpl,
        ),
      );
    } catch (err) {
      // The installation's permissions changed under the cached copy.
      if (err instanceof GitHubAppError && err.status === 422) {
        this.granted.delete(creds.installationId);
      }
      throw err;
    }
    const expiresAt = Date.parse(body.expires_at);
    if (Number.isNaN(expiresAt)) {
      throw new GitHubAppError(
        "GitHub token request returned no valid expiry",
        0,
      );
    }
    return {
      token: body.token,
      expiresAt,
      permissions: body.permissions ?? permissions,
      ...(body.repositories
        ? { repositories: body.repositories.map((r) => r.name) }
        : {}),
    };
  }

  /** The git identity the App's bot commits as (cached per App). */
  async botIdentity(
    creds: Pick<GitHubAppCredentials, "appId" | "privateKey">,
  ): Promise<GitIdentity> {
    const cached = this.identities.get(creds.appId);
    if (cached) return cached;
    const jwt = signAppJwt(creds.appId, creds.privateKey, this.now());
    const app = await this.call<{ slug: string }>("app lookup", () =>
      githubApiGet(jwt, "/app", this.fetchImpl),
    );
    // A public endpoint: GitHub takes the App JWT on `/app` paths only.
    const bot = await this.call<{ id: number }>("bot user lookup", () =>
      githubApiGetPublic(
        `/users/${encodeURIComponent(`${app.slug}[bot]`)}`,
        this.fetchImpl,
      ),
    );
    const identity = {
      name: `${app.slug}[bot]`,
      email: `${bot.id}+${app.slug}[bot]@users.noreply.github.com`,
    };
    this.identities.set(creds.appId, identity);
    return identity;
  }

  /** Best-effort: an installation token stays valid for an hour unless
   * revoked. Failures are logged, never thrown. */
  async revokeInstallationToken(token: string): Promise<void> {
    try {
      const response = await githubApiDelete(
        token,
        "/installation/token",
        this.fetchImpl,
      );
      if (!response.ok) {
        log.warn({ status: response.status }, "token revocation refused");
      }
    } catch {
      log.warn("token revocation failed: GitHub unreachable");
    }
  }
}
