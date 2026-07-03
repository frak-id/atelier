import type { ToolboxConfig } from "@atelier/spec";
import { and, asc, eq } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { orgToolboxes } from "../../db/schema.ts";

function rowToConfig(row: typeof orgToolboxes.$inferSelect): ToolboxConfig {
  return {
    id: row.id,
    orgId: row.orgId,
    slug: row.slug,
    description: row.description,
    source: row.source ?? undefined,
    build: row.build,
    paths: row.paths,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ToolboxRepository {
  list(orgId: string): ToolboxConfig[] {
    return getDatabase()
      .select()
      .from(orgToolboxes)
      .where(eq(orgToolboxes.orgId, orgId))
      .all()
      .map(rowToConfig);
  }

  /** Enabled toolboxes, oldest-first (per-org-toolboxes.md R6). */
  listEnabled(orgId: string): ToolboxConfig[] {
    return getDatabase()
      .select()
      .from(orgToolboxes)
      .where(and(eq(orgToolboxes.orgId, orgId), eq(orgToolboxes.enabled, 1)))
      .orderBy(asc(orgToolboxes.createdAt))
      .all()
      .map(rowToConfig);
  }

  getById(id: string): ToolboxConfig | undefined {
    const row = getDatabase()
      .select()
      .from(orgToolboxes)
      .where(eq(orgToolboxes.id, id))
      .get();
    return row ? rowToConfig(row) : undefined;
  }

  getByOrgAndSlug(orgId: string, slug: string): ToolboxConfig | undefined {
    const row = getDatabase()
      .select()
      .from(orgToolboxes)
      .where(and(eq(orgToolboxes.orgId, orgId), eq(orgToolboxes.slug, slug)))
      .get();
    return row ? rowToConfig(row) : undefined;
  }

  create(record: ToolboxConfig): ToolboxConfig {
    getDatabase()
      .insert(orgToolboxes)
      .values({
        id: record.id,
        orgId: record.orgId,
        slug: record.slug,
        description: record.description,
        source: record.source,
        build: record.build,
        paths: record.paths,
        enabled: record.enabled ? 1 : 0,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
      .run();
    return record;
  }

  update(id: string, patch: Partial<ToolboxConfig>): ToolboxConfig | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;
    const updated: ToolboxConfig = {
      ...existing,
      ...patch,
      id: existing.id,
      orgId: existing.orgId,
      slug: existing.slug,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    getDatabase()
      .update(orgToolboxes)
      .set({
        description: updated.description,
        source: updated.source,
        build: updated.build,
        paths: updated.paths,
        enabled: updated.enabled ? 1 : 0,
        updatedAt: updated.updatedAt,
      })
      .where(eq(orgToolboxes.id, id))
      .run();
    return updated;
  }

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;
    getDatabase().delete(orgToolboxes).where(eq(orgToolboxes.id, id)).run();
    return true;
  }
}
