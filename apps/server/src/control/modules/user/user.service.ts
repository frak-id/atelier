import { NotFoundError } from "../../../shared/errors.ts";
import { isAuthBypassed } from "../../../shared/lib/config.ts";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import type { User } from "../../types.ts";
import type { UserRepository } from "./user.repository.ts";

const log = createChildLogger("user-service");

export class UserService {
  constructor(private readonly userRepository: UserRepository) {}

  getAll(): User[] {
    return this.userRepository.getAll();
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
   * Single-tenant-friendly fallback: without a userId, falls back to any user
   * in the table with a token. Multi-org-aware control should scope this by
   * org membership instead (flagged as a v1 carryover, not re-solved here).
   */
  resolveGitHubToken(userId?: string): string | undefined {
    // local/mock modes have no real GitHub OAuth token (the stored user's
    // token, if any, is a fake placeholder) — `atelier local up` instead
    // injects the host's own token via ATELIER_GITHUB_TOKEN. Returning
    // undefined when it's absent (rather than falling through to the fake
    // token below) avoids writing a bogus credential into the sandbox, so
    // public repos still clone cleanly.
    if (isAuthBypassed()) {
      return process.env.ATELIER_GITHUB_TOKEN?.trim() || undefined;
    }
    if (userId) {
      const token = this.getById(userId)?.githubAccessToken;
      if (token) return token;
    }
    return this.userRepository.findFirstWithToken()?.githubAccessToken;
  }
}
