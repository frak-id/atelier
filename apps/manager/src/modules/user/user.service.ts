import type { User } from "../../schemas/index.ts";
import { NotFoundError } from "../../shared/errors.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
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
  ): User {
    const existing = this.userRepository.getById(githubId);
    const now = new Date().toISOString();

    const user: User = {
      id: githubId,
      username,
      email,
      avatarUrl,
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
}
