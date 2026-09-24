import type { Starter, ToolboxOwner } from "@atelier/spec";
import { and, asc, eq, or } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { launchpadStarters } from "../../db/schema.ts";

type StarterRow = typeof launchpadStarters.$inferSelect;

function rowToStarter(row: StarterRow): Starter {
  return {
    id: row.id,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    title: row.title,
    description: row.description,
    ...(row.icon ? { icon: row.icon } : {}),
    ...(row.guide ? { guide: row.guide } : {}),
    published: row.published === 1,
    recipe: row.recipe,
    services: row.services,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function ownerFilter(owner: ToolboxOwner) {
  return and(
    eq(launchpadStarters.ownerType, owner.type),
    eq(launchpadStarters.ownerId, owner.id),
  );
}

export class StarterRepository {
  list(owner: ToolboxOwner): Starter[] {
    return getDatabase()
      .select()
      .from(launchpadStarters)
      .where(ownerFilter(owner))
      .orderBy(asc(launchpadStarters.createdAt))
      .all()
      .map(rowToStarter);
  }

  /** Published starters across several owners, oldest-first (a stable
   * catalog order the authors control by creation). */
  listPublished(owners: ToolboxOwner[]): Starter[] {
    if (owners.length === 0) return [];
    return getDatabase()
      .select()
      .from(launchpadStarters)
      .where(
        and(eq(launchpadStarters.published, 1), or(...owners.map(ownerFilter))),
      )
      .orderBy(asc(launchpadStarters.createdAt))
      .all()
      .map(rowToStarter);
  }

  getById(id: string): Starter | undefined {
    const row = getDatabase()
      .select()
      .from(launchpadStarters)
      .where(eq(launchpadStarters.id, id))
      .get();
    return row ? rowToStarter(row) : undefined;
  }

  create(starter: Starter): Starter {
    getDatabase()
      .insert(launchpadStarters)
      .values({
        id: starter.id,
        ownerType: starter.ownerType,
        ownerId: starter.ownerId,
        title: starter.title,
        description: starter.description,
        icon: starter.icon ?? null,
        guide: starter.guide ?? null,
        published: starter.published ? 1 : 0,
        recipe: starter.recipe,
        services: starter.services,
        createdAt: starter.createdAt,
        updatedAt: starter.updatedAt,
      })
      .run();
    return starter;
  }

  /** Full-row write of an already-merged starter (the service merges). */
  save(starter: Starter): Starter {
    getDatabase()
      .update(launchpadStarters)
      .set({
        title: starter.title,
        description: starter.description,
        // `null`, not `undefined`: drizzle skips undefined columns on update,
        // so a cleared icon/guide would otherwise persist.
        icon: starter.icon ?? null,
        guide: starter.guide ?? null,
        published: starter.published ? 1 : 0,
        recipe: starter.recipe,
        services: starter.services,
        updatedAt: starter.updatedAt,
      })
      .where(eq(launchpadStarters.id, starter.id))
      .run();
    return starter;
  }

  delete(id: string): void {
    getDatabase()
      .delete(launchpadStarters)
      .where(eq(launchpadStarters.id, id))
      .run();
  }
}
