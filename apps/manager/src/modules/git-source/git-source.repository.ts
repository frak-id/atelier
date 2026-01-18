import { eq, sql } from "drizzle-orm";
import {
  getDatabase,
  gitSources,
} from "../../infrastructure/database/index.ts";
import type { GitSource } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("git-source-repository");

function rowToGitSource(row: typeof gitSources.$inferSelect): GitSource {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    config: row.config,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const GitSourceRepository = {
  getAll(): GitSource[] {
    return getDatabase().select().from(gitSources).all().map(rowToGitSource);
  },

  getById(id: string): GitSource | undefined {
    const row = getDatabase()
      .select()
      .from(gitSources)
      .where(eq(gitSources.id, id))
      .get();
    return row ? rowToGitSource(row) : undefined;
  },

  create(source: GitSource): GitSource {
    getDatabase()
      .insert(gitSources)
      .values({
        id: source.id,
        type: source.type,
        name: source.name,
        config: source.config,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      })
      .run();
    log.info({ sourceId: source.id, type: source.type }, "Git source created");
    return source;
  },

  update(id: string, updates: Partial<GitSource>): GitSource {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Git source '${id}' not found`);

    const updated: GitSource = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    getDatabase()
      .update(gitSources)
      .set({
        name: updated.name,
        config: updated.config,
        updatedAt: updated.updatedAt,
      })
      .where(eq(gitSources.id, id))
      .run();

    log.debug({ sourceId: id }, "Git source updated");
    return updated;
  },

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;

    getDatabase().delete(gitSources).where(eq(gitSources.id, id)).run();
    log.info({ sourceId: id }, "Git source deleted");
    return true;
  },

  count(): number {
    const result = getDatabase()
      .select({ count: sql<number>`count(*)` })
      .from(gitSources)
      .get();
    return result?.count ?? 0;
  },
};
