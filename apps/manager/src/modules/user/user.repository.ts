import { eq } from "drizzle-orm";
import { getDatabase, users } from "../../infrastructure/database/index.ts";
import type { User } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("user-repository");

function rowToUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    avatarUrl: row.avatarUrl ?? undefined,
    personalOrgId: row.personalOrgId ?? undefined,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
  };
}

export class UserRepository {
  getById(id: string): User | undefined {
    const row = getDatabase()
      .select()
      .from(users)
      .where(eq(users.id, id))
      .get();
    return row ? rowToUser(row) : undefined;
  }

  getByUsername(username: string): User | undefined {
    const row = getDatabase()
      .select()
      .from(users)
      .where(eq(users.username, username))
      .get();
    return row ? rowToUser(row) : undefined;
  }

  upsert(user: User): User {
    getDatabase()
      .insert(users)
      .values({
        id: user.id,
        username: user.username,
        email: user.email,
        avatarUrl: user.avatarUrl,
        personalOrgId: user.personalOrgId,
        createdAt: user.createdAt,
        lastLoginAt: user.lastLoginAt,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          username: user.username,
          email: user.email,
          avatarUrl: user.avatarUrl,
          lastLoginAt: user.lastLoginAt,
          personalOrgId: user.personalOrgId,
        },
      })
      .run();
    return user;
  }

  updatePersonalOrgId(userId: string, orgId: string): void {
    getDatabase()
      .update(users)
      .set({
        personalOrgId: orgId,
        lastLoginAt: new Date().toISOString(),
      })
      .where(eq(users.id, userId))
      .run();
    log.debug({ userId, orgId }, "User personal org updated");
  }
}
