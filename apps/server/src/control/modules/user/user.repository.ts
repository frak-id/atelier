import { asc, eq, isNotNull } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { organizations, orgMembers, users } from "../../db/schema.ts";
import type { DirectoryUser, User } from "../../types.ts";

function rowToUser(row: typeof users.$inferSelect): User {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    avatarUrl: row.avatarUrl ?? undefined,
    githubAccessToken: row.githubAccessToken ?? undefined,
    personalOrgId: row.personalOrgId ?? undefined,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
  };
}

export class UserRepository {
  getAll(): User[] {
    return getDatabase().select().from(users).all().map(rowToUser);
  }

  /**
   * Every user with their org memberships, oldest account first. Built from
   * one left join (a user with no membership still appears). Deliberately
   * never selects `github_access_token`.
   */
  listDirectory(): DirectoryUser[] {
    const rows = getDatabase()
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        avatarUrl: users.avatarUrl,
        personalOrgId: users.personalOrgId,
        createdAt: users.createdAt,
        lastLoginAt: users.lastLoginAt,
        orgId: organizations.id,
        orgName: organizations.name,
        orgSlug: organizations.slug,
        orgPersonal: organizations.personal,
        role: orgMembers.role,
      })
      .from(users)
      .leftJoin(orgMembers, eq(orgMembers.userId, users.id))
      .leftJoin(organizations, eq(organizations.id, orgMembers.orgId))
      .orderBy(asc(users.createdAt), asc(organizations.name))
      .all();

    const byId = new Map<string, DirectoryUser>();
    for (const row of rows) {
      let entry = byId.get(row.id);
      if (!entry) {
        entry = {
          id: row.id,
          username: row.username,
          email: row.email,
          avatarUrl: row.avatarUrl ?? undefined,
          personalOrgId: row.personalOrgId ?? undefined,
          createdAt: row.createdAt,
          lastLoginAt: row.lastLoginAt,
          organizations: [],
        };
        byId.set(row.id, entry);
      }
      if (row.orgId && row.orgName && row.orgSlug && row.role) {
        entry.organizations.push({
          id: row.orgId,
          name: row.orgName,
          slug: row.orgSlug,
          personal: row.orgPersonal === "true",
          role: row.role,
        });
      }
    }
    return [...byId.values()];
  }

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
        githubAccessToken: user.githubAccessToken,
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
          githubAccessToken: user.githubAccessToken,
          lastLoginAt: user.lastLoginAt,
          personalOrgId: user.personalOrgId,
        },
      })
      .run();
    return user;
  }

  findFirstWithToken(): User | undefined {
    const row = getDatabase()
      .select()
      .from(users)
      .where(isNotNull(users.githubAccessToken))
      .limit(1)
      .get();
    return row ? rowToUser(row) : undefined;
  }

  updatePersonalOrgId(userId: string, orgId: string): void {
    getDatabase()
      .update(users)
      .set({ personalOrgId: orgId, lastLoginAt: new Date().toISOString() })
      .where(eq(users.id, userId))
      .run();
  }
}
