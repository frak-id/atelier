import { eq, sql } from "drizzle-orm";
import {
  getDatabase,
  type SandboxStatus,
  sandboxes,
} from "../../infrastructure/database/index.ts";
import type { Sandbox } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("sandbox-repository");

function rowToSandbox(row: typeof sandboxes.$inferSelect): Sandbox {
  return {
    id: row.id,
    workspaceId: row.workspaceId ?? undefined,
    status: row.status,
    runtime: row.runtime,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SandboxRepository {
  getAll(): Sandbox[] {
    return getDatabase().select().from(sandboxes).all().map(rowToSandbox);
  }

  getById(id: string): Sandbox | undefined {
    const row = getDatabase()
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.id, id))
      .get();
    return row ? rowToSandbox(row) : undefined;
  }

  getByStatus(status: SandboxStatus): Sandbox[] {
    return getDatabase()
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.status, status))
      .all()
      .map(rowToSandbox);
  }

  getByWorkspaceId(workspaceId: string): Sandbox[] {
    return getDatabase()
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.workspaceId, workspaceId))
      .all()
      .map(rowToSandbox);
  }

  create(sandbox: Sandbox): Sandbox {
    getDatabase()
      .insert(sandboxes)
      .values({
        id: sandbox.id,
        workspaceId: sandbox.workspaceId ?? null,
        status: sandbox.status,
        runtime: sandbox.runtime,
        createdAt: sandbox.createdAt,
        updatedAt: sandbox.updatedAt,
      })
      .run();
    log.info({ sandboxId: sandbox.id }, "Sandbox created in database");
    return sandbox;
  }

  update(id: string, updates: Partial<Sandbox>): Sandbox {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Sandbox '${id}' not found`);

    const updated: Sandbox = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    getDatabase()
      .update(sandboxes)
      .set({
        workspaceId: updated.workspaceId ?? null,
        status: updated.status,
        runtime: updated.runtime,
        updatedAt: updated.updatedAt,
      })
      .where(eq(sandboxes.id, id))
      .run();

    log.debug({ sandboxId: id }, "Sandbox updated in database");
    return updated;
  }

  updateStatus(id: string, status: SandboxStatus, error?: string): Sandbox {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Sandbox '${id}' not found`);

    const runtime = error ? { ...existing.runtime, error } : existing.runtime;

    return this.update(id, { status, runtime });
  }

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;

    getDatabase().delete(sandboxes).where(eq(sandboxes.id, id)).run();
    log.info({ sandboxId: id }, "Sandbox deleted from database");
    return true;
  }

  count(): number {
    const result = getDatabase()
      .select({ count: sql<number>`count(*)` })
      .from(sandboxes)
      .get();
    return result?.count ?? 0;
  }

  countByStatus(status: SandboxStatus): number {
    const result = getDatabase()
      .select({ count: sql<number>`count(*)` })
      .from(sandboxes)
      .where(eq(sandboxes.status, status))
      .get();
    return result?.count ?? 0;
  }
}
