import { and, eq, sql } from "drizzle-orm";
import {
  getDatabase,
  type OrgMemberRole,
  orgMembers,
  users,
} from "../../infrastructure/database/index.ts";
import type { OrgMember } from "../../schemas/index.ts";

function rowToOrgMember(row: {
  org_members: typeof orgMembers.$inferSelect;
  users: typeof users.$inferSelect;
}): OrgMember {
  return {
    id: row.org_members.id,
    orgId: row.org_members.orgId,
    userId: row.org_members.userId,
    username: row.users.username,
    avatarUrl: row.users.avatarUrl ?? undefined,
    role: row.org_members.role,
    joinedAt: row.org_members.joinedAt,
  };
}

export class OrgMemberRepository {
  getByOrgId(orgId: string): OrgMember[] {
    return getDatabase()
      .select()
      .from(orgMembers)
      .innerJoin(users, eq(orgMembers.userId, users.id))
      .where(eq(orgMembers.orgId, orgId))
      .all()
      .map(rowToOrgMember);
  }

  getByUserId(userId: string): OrgMember[] {
    return getDatabase()
      .select()
      .from(orgMembers)
      .innerJoin(users, eq(orgMembers.userId, users.id))
      .where(eq(orgMembers.userId, userId))
      .all()
      .map(rowToOrgMember);
  }

  getByOrgAndUser(orgId: string, userId: string): OrgMember | undefined {
    const row = getDatabase()
      .select()
      .from(orgMembers)
      .innerJoin(users, eq(orgMembers.userId, users.id))
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
      .get();
    return row ? rowToOrgMember(row) : undefined;
  }

  create(member: {
    id: string;
    orgId: string;
    userId: string;
    role: OrgMemberRole;
    joinedAt: string;
  }): void {
    getDatabase()
      .insert(orgMembers)
      .values({
        id: member.id,
        orgId: member.orgId,
        userId: member.userId,
        role: member.role,
        joinedAt: member.joinedAt,
      })
      .run();
  }

  updateRole(id: string, role: OrgMemberRole): void {
    getDatabase()
      .update(orgMembers)
      .set({ role })
      .where(eq(orgMembers.id, id))
      .run();
  }

  delete(id: string): boolean {
    const existing = getDatabase()
      .select()
      .from(orgMembers)
      .where(eq(orgMembers.id, id))
      .get();
    if (!existing) return false;

    getDatabase().delete(orgMembers).where(eq(orgMembers.id, id)).run();
    return true;
  }

  deleteByOrgAndUser(orgId: string, userId: string): boolean {
    const existing = getDatabase()
      .select()
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
      .get();
    if (!existing) return false;

    getDatabase()
      .delete(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
      .run();
    return true;
  }

  countByOrgId(orgId: string): number {
    const result = getDatabase()
      .select({ count: sql<number>`count(*)` })
      .from(orgMembers)
      .where(eq(orgMembers.orgId, orgId))
      .get();
    return result?.count ?? 0;
  }
}
