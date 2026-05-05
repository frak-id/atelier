import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
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
    orgId: row.orgId ?? undefined,
    workspaceId: row.workspaceId ?? undefined,
    createdBy: row.createdBy ?? undefined,
    name: row.name ?? undefined,
    origin: row.origin ?? undefined,
    status: row.status,
    runtime: row.runtime,
    opencodeWorkspaceContext: row.opencodeWorkspaceContext ?? undefined,
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

  getByOrgId(orgId: string): Sandbox[] {
    return getDatabase()
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.orgId, orgId))
      .all()
      .map(rowToSandbox);
  }

  getByOrgIds(orgIds: string[]): Sandbox[] {
    const conditions = [isNull(sandboxes.orgId)];
    if (orgIds.length > 0) {
      conditions.push(inArray(sandboxes.orgId, orgIds));
    }
    return getDatabase()
      .select()
      .from(sandboxes)
      .where(or(...conditions))
      .all()
      .map(rowToSandbox);
  }

  create(sandbox: Sandbox): Sandbox {
    getDatabase()
      .insert(sandboxes)
      .values({
        id: sandbox.id,
        orgId: sandbox.orgId ?? null,
        workspaceId: sandbox.workspaceId ?? null,
        createdBy: sandbox.createdBy ?? null,
        name: sandbox.name ?? null,
        origin: sandbox.origin ?? null,
        status: sandbox.status,
        runtime: sandbox.runtime,
        opencodeWorkspaceContext: sandbox.opencodeWorkspaceContext ?? null,
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
        orgId: updated.orgId ?? null,
        workspaceId: updated.workspaceId ?? null,
        createdBy: updated.createdBy ?? null,
        name: updated.name ?? null,
        origin: updated.origin ?? null,
        status: updated.status,
        runtime: updated.runtime,
        opencodeWorkspaceContext: updated.opencodeWorkspaceContext ?? null,
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

  /**
   * Lookup the most recently updated sandbox spawned by a given source
   * with a given external id. Used by integrations (e.g. opencode-plugin)
   * to recover their previously created sandbox without persisting our id.
   */
  findByOrigin(source: string, externalId: string): Sandbox | undefined {
    const row = getDatabase()
      .select()
      .from(sandboxes)
      .where(originPredicate(source, externalId))
      .orderBy(sql`${sandboxes.updatedAt} desc`)
      .get();
    return row ? rowToSandbox(row) : undefined;
  }

  /**
   * List all sandboxes spawned by a given source, optionally narrowed by
   * external id. Mirrors the `?originSource=&originExternalId=` HTTP query.
   */
  findAllByOrigin(source: string, externalId?: string): Sandbox[] {
    return getDatabase()
      .select()
      .from(sandboxes)
      .where(originPredicate(source, externalId))
      .orderBy(sql`${sandboxes.updatedAt} desc`)
      .all()
      .map(rowToSandbox);
  }
}

function originPredicate(source: string, externalId?: string) {
  const sourceClause = eq(
    sql`json_extract(${sandboxes.origin}, '$.source')`,
    source,
  );
  if (externalId === undefined) return sourceClause;
  return and(
    sourceClause,
    eq(sql`json_extract(${sandboxes.origin}, '$.externalId')`, externalId),
  );
}
