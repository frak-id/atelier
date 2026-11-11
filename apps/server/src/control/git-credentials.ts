/**
 * Who a sandbox's git operations run as: the one place that turns an owner
 * id into a git identity and a GitHub token.
 *
 * A person gets their own OAuth token (or, in local mode, the host's). A
 * service account gets only its own credential: a GitHub App installation
 * token (cached, re-minted before it expires) or a static token. When that
 * is missing or fails, the result has no token: it never falls back to
 * anyone else's.
 */
import { createHash } from "node:crypto";
import { ValidationError } from "../shared/errors.ts";
import type { GitIdentity } from "../shared/lib/git-attribution.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type {
  AppPermissions,
  GitHubAppClient,
  GitHubAppCredentials,
} from "./github-app.ts";
import type { ServiceAccountRepository } from "./modules/service-account/index.ts";
import type { UserService } from "./modules/user/index.ts";

const log = createChildLogger("git-credentials");

/** A cached token is reused while more than this remains. */
const REFRESH_MARGIN_MS = 15 * 60 * 1000;

/** When a mint fails, a cached token with more than this left is still
 * handed out (better than none). */
const FALLBACK_MARGIN_MS = 2 * 60 * 1000;

export interface ResolvedGitCredential {
  token?: string;
  identity?: GitIdentity;
  /** Epoch ms; only for a token that expires (an App installation token). */
  expiresAt?: number;
  /** A service account with no GitHub credential at all (not one whose
   * mint failed or whose secret is unreadable): its sandboxes must not keep
   * an old token. */
  noCredential?: true;
}

/** What "Test connection" reports. */
export interface GitCredentialCheck {
  identity: GitIdentity;
  expiresAt: number;
  permissions: AppPermissions;
  repositories?: string[];
}

export interface GitCredentialDeps {
  users: Pick<UserService, "getById" | "resolveGitHubToken">;
  serviceAccounts: Pick<ServiceAccountRepository, "getGitHub">;
  app: Pick<
    GitHubAppClient,
    "mintInstallationToken" | "botIdentity" | "revokeInstallationToken"
  >;
  now?: () => number;
}

interface CachedToken {
  fingerprint: string;
  token: string;
  expiresAt: number;
}

/** Changes whenever the credential does, the private key included, so an
 * edited credential re-mints. Hashed: the key never sits in a map key. */
function fingerprintOf(creds: GitHubAppCredentials): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        creds.appId,
        creds.installationId,
        creds.privateKey,
        creds.repositories ?? null,
        creds.permissions ?? null,
      ]),
    )
    .digest("hex");
}

export class GitCredentialService {
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedToken>();
  private readonly inFlight = new Map<
    string,
    { fingerprint: string; promise: Promise<CachedToken> }
  >();

  constructor(private readonly deps: GitCredentialDeps) {
    this.now = deps.now ?? Date.now;
  }

  async resolve(userId: string): Promise<ResolvedGitCredential> {
    const user = this.deps.users.getById(userId);
    if (!user) {
      // No row: a service account has nothing; anyone else gets the host
      // token in local mode (the mock user has a row only after /auth/github).
      if (userId.startsWith("sa_")) return {};
      const token = this.deps.users.resolveGitHubToken(userId);
      return token ? { token } : {};
    }
    const own: GitIdentity = { name: user.username, email: user.email };
    if (user.kind !== "service") {
      const token = this.deps.users.resolveGitHubToken(userId);
      return { identity: own, ...(token ? { token } : {}) };
    }

    const github = this.deps.serviceAccounts.getGitHub(userId);
    if (!github) {
      this.cache.delete(userId);
      return { identity: own, noCredential: true };
    }
    if (github.kind === "unreadable") {
      // Not "no credential": keep whatever the sandboxes hold.
      log.error(
        { userId },
        "service account GitHub secret is unreadable (wrong SANDBOX_SECRETS_KEY?); keeping the last token",
      );
      return { identity: own };
    }
    if (github.kind === "token") {
      return {
        token: github.token,
        identity: { name: github.gitName, email: github.gitEmail },
      };
    }

    const identity = await this.botIdentityOf(userId, github, own);
    try {
      const cached = await this.appToken(userId, github);
      return { token: cached.token, identity, expiresAt: cached.expiresAt };
    } catch (err) {
      // A boot must not fail because GitHub is down.
      const cached = this.cache.get(userId);
      if (
        cached?.fingerprint === fingerprintOf(github) &&
        cached.expiresAt - this.now() > FALLBACK_MARGIN_MS
      ) {
        log.warn(
          { userId, err: err instanceof Error ? err.message : "unknown" },
          "could not mint a GitHub App token; using the cached one",
        );
        return { token: cached.token, identity, expiresAt: cached.expiresAt };
      }
      log.warn(
        { userId, err: err instanceof Error ? err.message : "unknown" },
        "could not mint a GitHub App token; booting without one",
      );
      return { identity };
    }
  }

  async token(userId: string): Promise<string | undefined> {
    return (await this.resolve(userId)).token;
  }

  /** Drop the cached token of a service account (its credential was edited,
   * removed or the account deleted). `revoke` also kills the token at GitHub,
   * best-effort. */
  async forget(userId: string, opts: { revoke?: boolean } = {}): Promise<void> {
    const cached = this.cache.get(userId);
    this.cache.delete(userId);
    this.inFlight.delete(userId);
    if (opts.revoke && cached) {
      await this.deps.app.revokeInstallationToken(cached.token);
    }
  }

  /** Mint a fresh installation token (bypassing both caches, then caching
   * the token) and report what it can do. Errors surface: this is the
   * admin's test. */
  async check(userId: string): Promise<GitCredentialCheck> {
    const github = this.deps.serviceAccounts.getGitHub(userId);
    if (github?.kind === "unreadable") {
      throw new ValidationError(
        "The stored GitHub credential can't be decrypted: set it again",
      );
    }
    if (github?.kind !== "app") {
      throw new ValidationError(
        "This service account has no GitHub App credential to test",
      );
    }
    const minted = await this.deps.app.mintInstallationToken(github, {
      fresh: true,
    });
    this.cache.set(userId, {
      fingerprint: fingerprintOf(github),
      token: minted.token,
      expiresAt: minted.expiresAt,
    });
    const identity = await this.deps.app.botIdentity(github);
    return {
      identity,
      expiresAt: minted.expiresAt,
      permissions: minted.permissions,
      ...(minted.repositories ? { repositories: minted.repositories } : {}),
    };
  }

  private async botIdentityOf(
    userId: string,
    github: GitHubAppCredentials,
    fallback: GitIdentity,
  ): Promise<GitIdentity> {
    try {
      return await this.deps.app.botIdentity(github);
    } catch (err) {
      log.warn(
        { userId, err: err instanceof Error ? err.message : "unknown" },
        "could not look up the GitHub App bot identity",
      );
      return fallback;
    }
  }

  private appToken(
    userId: string,
    github: GitHubAppCredentials,
  ): Promise<CachedToken> {
    const fingerprint = fingerprintOf(github);
    const cached = this.cache.get(userId);
    if (
      cached &&
      cached.fingerprint === fingerprint &&
      cached.expiresAt - this.now() > REFRESH_MARGIN_MS
    ) {
      return Promise.resolve(cached);
    }
    const pending = this.inFlight.get(userId);
    if (pending && pending.fingerprint === fingerprint) return pending.promise;

    const promise = this.deps.app
      .mintInstallationToken(github)
      .then((minted) => {
        const entry = {
          fingerprint,
          token: minted.token,
          expiresAt: minted.expiresAt,
        };
        // A mint superseded by a newer credential (or a forget) must not
        // overwrite the newer entry.
        if (this.inFlight.get(userId)?.promise === promise) {
          this.cache.set(userId, entry);
        }
        return entry;
      })
      .finally(() => {
        if (this.inFlight.get(userId)?.promise === promise) {
          this.inFlight.delete(userId);
        }
      });
    this.inFlight.set(userId, { fingerprint, promise });
    return promise;
  }
}
