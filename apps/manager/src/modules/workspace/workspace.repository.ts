import { eq, sql } from "drizzle-orm";
import {
  configFiles,
  getDatabase,
  sandboxes,
  tasks,
  workspaces,
} from "../../infrastructure/database/index.ts";
import type { Workspace } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("workspace-repository");

function rowToWorkspace(row: typeof workspaces.$inferSelect): Workspace {
  return {
    id: row.id,
    name: row.name,
    config: row.config,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class WorkspaceRepository {
  getAll(): Workspace[] {
    return getDatabase().select().from(workspaces).all().map(rowToWorkspace);
  }

  getById(id: string): Workspace | undefined {
    const row = getDatabase()
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .get();
    return row ? rowToWorkspace(row) : undefined;
  }

  create(workspace: Workspace): Workspace {
    getDatabase()
      .insert(workspaces)
      .values({
        id: workspace.id,
        name: workspace.name,
        config: workspace.config,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })
      .run();
    log.info(
      { workspaceId: workspace.id, name: workspace.name },
      "Workspace created",
    );
    return workspace;
  }

  update(id: string, updates: Partial<Workspace>): Workspace {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Workspace '${id}' not found`);

    const updated: Workspace = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    getDatabase()
      .update(workspaces)
      .set({
        name: updated.name,
        config: updated.config,
        updatedAt: updated.updatedAt,
      })
      .where(eq(workspaces.id, id))
      .run();

    log.debug({ workspaceId: id }, "Workspace updated");
    return updated;
  }

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;

    const db = getDatabase();
    db.delete(tasks).where(eq(tasks.workspaceId, id)).run();
    db.delete(configFiles).where(eq(configFiles.workspaceId, id)).run();
    db.delete(sandboxes).where(eq(sandboxes.workspaceId, id)).run();
    db.delete(workspaces).where(eq(workspaces.id, id)).run();
    log.info({ workspaceId: id }, "Workspace deleted");
    return true;
  }

  count(): number {
    const result = getDatabase()
      .select({ count: sql<number>`count(*)` })
      .from(workspaces)
      .get();
    return result?.count ?? 0;
  }
}
