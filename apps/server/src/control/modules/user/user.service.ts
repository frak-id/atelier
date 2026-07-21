import { NotFoundError } from "../../../shared/errors.ts";
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
    if (userId) {
      const token = this.getById(userId)?.githubAccessToken;
      if (token) return token;
    }
    return this.userRepository.findFirstWithToken()?.githubAccessToken;
  }
}
