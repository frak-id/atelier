import type { ToolboxConfig, ToolboxOwner } from "@atelier/spec";
import { and, asc, eq } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { entityToolboxes } from "../../db/schema.ts";

function rowToConfig(row: typeof entityToolboxes.$inferSelect): ToolboxConfig {
  return {
    id: row.id,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
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

/** The single owner predicate shared by every scoped query. */
function ownerFilter(owner: ToolboxOwner) {
  return and(
    eq(entityToolboxes.ownerType, owner.type),
    eq(entityToolboxes.ownerId, owner.id),
  );
}

export class ToolboxRepository {
  list(owner: ToolboxOwner): ToolboxConfig[] {
    return getDatabase()
      .select()
      .from(entityToolboxes)
      .where(ownerFilter(owner))
      .orderBy(asc(entityToolboxes.createdAt))
      .all()
      .map(rowToConfig);
  }

  /** Enabled toolboxes, oldest-first (entities-toolbox.md R6). */
  listEnabled(owner: ToolboxOwner): ToolboxConfig[] {
    return getDatabase()
      .select()
      .from(entityToolboxes)
      .where(and(ownerFilter(owner), eq(entityToolboxes.enabled, 1)))
      .orderBy(asc(entityToolboxes.createdAt))
      .all()
      .map(rowToConfig);
  }

  getById(id: string): ToolboxConfig | undefined {
    const row = getDatabase()
      .select()
      .from(entityToolboxes)
      .where(eq(entityToolboxes.id, id))
      .get();
    return row ? rowToConfig(row) : undefined;
  }

  getByOwnerAndSlug(
    owner: ToolboxOwner,
    slug: string,
  ): ToolboxConfig | undefined {
    const row = getDatabase()
      .select()
      .from(entityToolboxes)
      .where(and(ownerFilter(owner), eq(entityToolboxes.slug, slug)))
      .get();
    return row ? rowToConfig(row) : undefined;
  }

  create(record: ToolboxConfig): ToolboxConfig {
    getDatabase()
      .insert(entityToolboxes)
      .values({
        id: record.id,
        ownerType: record.ownerType,
        ownerId: record.ownerId,
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
      ownerType: existing.ownerType,
      ownerId: existing.ownerId,
      slug: existing.slug,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    getDatabase()
      .update(entityToolboxes)
      .set({
        description: updated.description,
        source: updated.source,
        build: updated.build,
        paths: updated.paths,
        enabled: updated.enabled ? 1 : 0,
        updatedAt: updated.updatedAt,
      })
      .where(eq(entityToolboxes.id, id))
      .run();
    return updated;
  }

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;
    getDatabase()
      .delete(entityToolboxes)
      .where(eq(entityToolboxes.id, id))
      .run();
    return true;
  }
}
