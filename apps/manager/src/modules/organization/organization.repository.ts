import { eq, sql } from "drizzle-orm";
import {
  getDatabase,
  organizations,
  orgMembers,
} from "../../infrastructure/database/index.ts";
import type { Organization } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("organization-repository");

function rowToOrganization(
  row: typeof organizations.$inferSelect,
): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    avatarUrl: row.avatarUrl ?? undefined,
    personal: row.personal === "true",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class OrganizationRepository {
  getAll(): Organization[] {
    return getDatabase()
      .select()
      .from(organizations)
      .all()
      .map(rowToOrganization);
  }

  getById(id: string): Organization | undefined {
    const row = getDatabase()
      .select()
      .from(organizations)
      .where(eq(organizations.id, id))
      .get();
    return row ? rowToOrganization(row) : undefined;
  }

  getBySlug(slug: string): Organization | undefined {
    const row = getDatabase()
      .select()
      .from(organizations)
      .where(eq(organizations.slug, slug))
      .get();
    return row ? rowToOrganization(row) : undefined;
  }

  getByUserId(userId: string): Organization[] {
    const rows = getDatabase()
      .select()
      .from(organizations)
      .innerJoin(orgMembers, eq(organizations.id, orgMembers.orgId))
      .where(eq(orgMembers.userId, userId))
      .all();
    return rows.map((row) => rowToOrganization(row.organizations));
  }

  create(org: Organization): Organization {
    getDatabase()
      .insert(organizations)
      .values({
        id: org.id,
        name: org.name,
        slug: org.slug,
        avatarUrl: org.avatarUrl,
        personal: org.personal ? "true" : "false",
        createdAt: org.createdAt,
        updatedAt: org.updatedAt,
      })
      .run();
    log.info(
      { organizationId: org.id, name: org.name },
      "Organization created",
    );
    return org;
  }

  update(id: string, updates: Partial<Organization>): Organization {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Organization '${id}' not found`);

    const updated: Organization = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    getDatabase()
      .update(organizations)
      .set({
        name: updated.name,
        slug: updated.slug,
        avatarUrl: updated.avatarUrl,
        personal: updated.personal ? "true" : "false",
        updatedAt: updated.updatedAt,
      })
      .where(eq(organizations.id, id))
      .run();

    log.debug({ organizationId: id }, "Organization updated");
    return updated;
  }

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;

    getDatabase().delete(organizations).where(eq(organizations.id, id)).run();
    log.info({ organizationId: id }, "Organization deleted");
    return true;
  }

  count(): number {
    const result = getDatabase()
      .select({ count: sql<number>`count(*)` })
      .from(organizations)
      .get();
    return result?.count ?? 0;
  }
}
