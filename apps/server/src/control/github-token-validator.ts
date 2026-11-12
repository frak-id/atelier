/**
 * Notices when GitHub stops accepting a person's stored OAuth token, so their
 * console session ends instead of living on with a dead token.
 *
 * An OAuth App token has no expiry date, but GitHub kills it when the user
 * revokes the app, when it goes unused for a year, or when more than ten
 * tokens exist for the same user and scopes (the oldest goes). Atelier learns
 * about it in two places: the console's session check (`/auth/me`, through
 * `ensureValid`, at most one GitHub call per person every few minutes) and
 * any GitHub call made with the token that answers 401 (`rejected`). Either
 * way the token is dropped, and a person without a stored token has no
 * session (`AuthService.verifySession`): the next login stores a new one.
 */
import { isAuthBypassed } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { checkGitHubToken, type GitHubTokenStatus } from "./github-oauth.ts";
import type { UserService } from "./modules/user/index.ts";

const log = createChildLogger("github-token-validator");

/** A token GitHub accepted is not asked about again for this long. */
const CHECK_TTL_MS = 5 * 60 * 1000;

/** How long `ensureValid` waits for GitHub before answering "valid": the
 * session check is on the console's load path. A slower answer still drops
 * a rejected token when it lands. */
const CHECK_WAIT_MS = 3000;

export interface GitHubTokenValidatorDeps {
  users: Pick<UserService, "getById" | "dropGitHubToken">;
  check?: (token: string) => Promise<GitHubTokenStatus>;
  now?: () => number;
  waitMs?: number;
  /** Test seam; defaults to the server mode. */
  bypassed?: () => boolean;
}

export class GitHubTokenValidator {
  /** The token GitHub last accepted, and when, per person. */
  private readonly accepted = new Map<string, { token: string; at: number }>();
  private readonly inFlight = new Map<
    string,
    { token: string; promise: Promise<boolean> }
  >();

  constructor(private readonly deps: GitHubTokenValidatorDeps) {}

  /**
   * Whether `userId` still holds a GitHub token that GitHub accepts. A
   * rejected one is dropped. A GitHub that can't be reached or answers late
   * counts as accepting it. Always true on an auth-bypassed server (it has
   * no real token).
   */
  async ensureValid(userId: string): Promise<boolean> {
    if (this.bypassed()) return true;
    const token = this.deps.users.getById(userId)?.githubAccessToken;
    if (!token) return false;
    const seen = this.accepted.get(userId);
    if (seen?.token === token && this.now() - seen.at < CHECK_TTL_MS) {
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<boolean>((resolve) => {
      timer = setTimeout(
        () => resolve(true),
        this.deps.waitMs ?? CHECK_WAIT_MS,
      );
    });
    try {
      return await Promise.race([this.checkOnce(userId, token), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** GitHub answered 401 to `token`, used on `userId`'s behalf: drop it,
   * unless a newer login replaced it. */
  rejected(userId: string, token: string): void {
    if (this.bypassed()) return;
    if (this.accepted.get(userId)?.token === token) {
      this.accepted.delete(userId);
    }
    this.deps.users.dropGitHubToken(userId, token);
  }

  private checkOnce(userId: string, token: string): Promise<boolean> {
    const pending = this.inFlight.get(userId);
    if (pending?.token === token) return pending.promise;
    const promise = this.ask(userId, token).finally(() => {
      if (this.inFlight.get(userId)?.promise === promise) {
        this.inFlight.delete(userId);
      }
    });
    this.inFlight.set(userId, { token, promise });
    return promise;
  }

  /** Never rejects: a failure to check is not a reason to sign out. */
  private async ask(userId: string, token: string): Promise<boolean> {
    try {
      const status = await (this.deps.check ?? checkGitHubToken)(token);
      if (status === "valid") {
        this.accepted.set(userId, { token, at: this.now() });
      } else if (status === "revoked") {
        this.rejected(userId, token);
        // A login that stored a new token meanwhile keeps the session.
        return !!this.deps.users.getById(userId)?.githubAccessToken;
      }
      return true;
    } catch (err) {
      log.warn(
        { userId, err: err instanceof Error ? err.message : "unknown" },
        "GitHub token check failed",
      );
      return true;
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private bypassed(): boolean {
    return this.deps.bypassed?.() ?? isAuthBypassed();
  }
}
