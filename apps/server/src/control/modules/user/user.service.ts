import { NotFoundError } from "../../../shared/errors.ts";
import { isAuthBypassed } from "../../../shared/lib/config.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type { DirectoryUser, User } from "../../types.ts";
import type { UserRepository } from "./user.repository.ts";

const log = createChildLogger("user-service");

export class UserService {
  constructor(private readonly userRepository: UserRepository) {}

  getAll(): User[] {
    return this.userRepository.getAll();
  }

  /** Every registered user with their org memberships (no tokens). */
  listDirectory(): DirectoryUser[] {
    return this.userRepository.listDirectory();
  }

  getById(id: string): User | undefined {
    return this.userRepository.getById(id);
  }

  getByIdOrThrow(id: string): User {
    const user = this.userRepository.getById(id);
    if (!user) throw new NotFoundError("User", id);
    return user;
  }

  getByUsername(username: string): User | undefined {
    return this.userRepository.getByUsername(username);
  }

  upsertFromLogin(
    githubId: string,
    username: string,
    email: string,
    avatarUrl: string,
    accessToken?: string,
  ): User {
    const existing = this.userRepository.getById(githubId);
    const now = new Date().toISOString();
    const user: User = {
      id: githubId,
      kind: "human",
      username,
      email,
      avatarUrl,
      githubAccessToken: accessToken ?? existing?.githubAccessToken,
      personalOrgId: existing?.personalOrgId,
      createdAt: existing?.createdAt ?? now,
      lastLoginAt: now,
    };
    this.userRepository.upsert(user);
    log.info({ userId: githubId, username }, "User upserted from login");
    return user;
  }

  setPersonalOrg(userId: string, orgId: string): void {
    this.userRepository.updatePersonalOrgId(userId, orgId);
  }

  /**
   * The GitHub token to clone with on `userId`'s behalf: that user's own
   * OAuth token, never anyone else's. A user without one gets `undefined`
   * (public repos still clone; private ones fail loudly at clone time).
   * Human users only: a service account has no OAuth token, and never gets
   * the operator's host token either (its credential is its own, resolved
   * from `service_accounts`).
   */
  resolveGitHubToken(userId: string): string | undefined {
    const user = this.getById(userId);
    if (user?.kind === "service") return undefined;
    // local mode has no real GitHub OAuth token (the stored user's
    // token, if any, is a fake placeholder) — the operator instead
    // provides the host's own token via ATELIER_GITHUB_TOKEN. Returning
    // undefined when it's absent (rather than falling through to the fake
    // token below) avoids writing a bogus credential into the sandbox, so
    // public repos still clone cleanly.
    if (isAuthBypassed()) {
      return process.env.ATELIER_GITHUB_TOKEN?.trim() || undefined;
    }
    return user?.githubAccessToken || undefined;
  }
}
