import { eq, inArray, isNull, or, sql } from "drizzle-orm";
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
    orgId: row.orgId ?? undefined,
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

  getByOrgId(orgId: string): Workspace[] {
    return getDatabase()
      .select()
      .from(workspaces)
      .where(eq(workspaces.orgId, orgId))
      .all()
      .map(rowToWorkspace);
  }

  getByOrgIds(orgIds: string[]): Workspace[] {
    const conditions = [isNull(workspaces.orgId)];
    if (orgIds.length > 0) {
      conditions.push(inArray(workspaces.orgId, orgIds));
    }
    return getDatabase()
      .select()
      .from(workspaces)
      .where(or(...conditions))
      .all()
      .map(rowToWorkspace);
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
        orgId: workspace.orgId ?? null,
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
        orgId: updated.orgId ?? null,
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

  transferOrg(workspaceId: string, newOrgId: string): Workspace {
    const existing = this.getById(workspaceId);
    if (!existing) throw new Error(`Workspace '${workspaceId}' not found`);

    const now = new Date().toISOString();
    const db = getDatabase();

    db.update(workspaces)
      .set({ orgId: newOrgId, updatedAt: now })
      .where(eq(workspaces.id, workspaceId))
      .run();

    db.update(tasks)
      .set({ orgId: newOrgId })
      .where(eq(tasks.workspaceId, workspaceId))
      .run();

    db.update(sandboxes)
      .set({ orgId: newOrgId })
      .where(eq(sandboxes.workspaceId, workspaceId))
      .run();

    db.update(configFiles)
      .set({ orgId: newOrgId })
      .where(eq(configFiles.workspaceId, workspaceId))
      .run();

    log.info(
      { workspaceId, newOrgId },
      "Workspace transferred to new organization",
    );

    return { ...existing, orgId: newOrgId, updatedAt: now };
  }
}
