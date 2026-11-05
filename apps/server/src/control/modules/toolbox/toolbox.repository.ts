import type { ToolboxConfig, ToolboxRefreshStatus } from "@atelier/spec";
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { toolboxes } from "../../db/schema.ts";

function rowToConfig(row: typeof toolboxes.$inferSelect): ToolboxConfig {
  return {
    id: row.id,
    orgId: row.orgId,
    slug: row.slug,
    description: row.description,
    source: row.source ?? undefined,
    build: row.build,
    paths: row.paths,
    harness: row.harness ?? undefined,
    processes: row.processes ?? undefined,
    ports: row.ports ?? undefined,
    files: row.files ?? undefined,
    autoInject: row.autoInject === 1,
    refresh: row.refresh,
    refreshSchedule: row.refreshSchedule ?? undefined,
    nextRefreshAt: row.nextRefreshAt ?? undefined,
    lastRefresh: row.lastRefresh ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class ToolboxRepository {
  list(orgId: string): ToolboxConfig[] {
    return getDatabase()
      .select()
      .from(toolboxes)
      .where(eq(toolboxes.orgId, orgId))
      .orderBy(asc(toolboxes.createdAt))
      .all()
      .map(rowToConfig);
  }

  /** Auto-inject toolboxes, oldest-first. */
  listAutoInject(orgId: string): ToolboxConfig[] {
    return getDatabase()
      .select()
      .from(toolboxes)
      .where(and(eq(toolboxes.orgId, orgId), eq(toolboxes.autoInject, 1)))
      .orderBy(asc(toolboxes.createdAt))
      .all()
      .map(rowToConfig);
  }

  getById(id: string): ToolboxConfig | undefined {
    const row = getDatabase()
      .select()
      .from(toolboxes)
      .where(eq(toolboxes.id, id))
      .get();
    return row ? rowToConfig(row) : undefined;
  }

  getByOrgAndSlug(orgId: string, slug: string): ToolboxConfig | undefined {
    const row = getDatabase()
      .select()
      .from(toolboxes)
      .where(and(eq(toolboxes.orgId, orgId), eq(toolboxes.slug, slug)))
      .get();
    return row ? rowToConfig(row) : undefined;
  }

  create(record: ToolboxConfig): ToolboxConfig {
    getDatabase()
      .insert(toolboxes)
      .values({
        id: record.id,
        orgId: record.orgId,
        slug: record.slug,
        description: record.description,
        source: record.source,
        build: record.build,
        paths: record.paths,
        harness: record.harness,
        processes: record.processes,
        ports: record.ports,
        files: record.files,
        autoInject: record.autoInject ? 1 : 0,
        refresh: record.refresh,
        refreshSchedule: record.refreshSchedule ?? null,
        nextRefreshAt: record.nextRefreshAt ?? null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
      .run();
    return record;
  }

  /**
   * Toolboxes whose scheduled refresh is due at `nowIso`, oldest-due first.
   * Only rows with a `nextRefreshAt` (a schedule AND update commands) can
   * match. ISO-8601 UTC strings compare correctly as text.
   */
  listDueForRefresh(nowIso: string): ToolboxConfig[] {
    return getDatabase()
      .select()
      .from(toolboxes)
      .where(
        and(
          isNotNull(toolboxes.nextRefreshAt),
          lte(toolboxes.nextRefreshAt, nowIso),
        ),
      )
      .orderBy(asc(toolboxes.nextRefreshAt))
      .all()
      .map(rowToConfig);
  }

  /** Scheduler bookkeeping, not a config edit: `updatedAt` stays put. */
  setNextRefreshAt(id: string, nextRefreshAt: string | null): void {
    getDatabase()
      .update(toolboxes)
      .set({ nextRefreshAt })
      .where(eq(toolboxes.id, id))
      .run();
  }

  /** Record a finished refresh's outcome (not a config edit either). */
  setLastRefresh(id: string, status: ToolboxRefreshStatus): void {
    getDatabase()
      .update(toolboxes)
      .set({ lastRefresh: status })
      .where(eq(toolboxes.id, id))
      .run();
  }

  update(
    id: string,
    patch: Partial<
      Omit<
        ToolboxConfig,
        | "harness"
        | "source"
        | "refreshSchedule"
        | "nextRefreshAt"
        | "lastRefresh"
      >
    > & {
      harness?: string | null;
      source?: ToolboxConfig["source"] | null;
      refreshSchedule?: string | null;
      nextRefreshAt?: string | null;
    },
  ): ToolboxConfig | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;
    // `harness: null` clears it; an absent key keeps the existing value.
    const harness =
      patch.harness === undefined
        ? existing.harness
        : (patch.harness ?? undefined);
    // `source: null` clears the override; an absent key keeps it (same
    // absent-vs-null contract as `harness`).
    const source =
      patch.source === undefined
        ? existing.source
        : (patch.source ?? undefined);
    const refreshSchedule =
      patch.refreshSchedule === undefined
        ? existing.refreshSchedule
        : (patch.refreshSchedule ?? undefined);
    const nextRefreshAt =
      patch.nextRefreshAt === undefined
        ? existing.nextRefreshAt
        : (patch.nextRefreshAt ?? undefined);
    const updated: ToolboxConfig = {
      ...existing,
      ...patch,
      harness,
      source,
      refreshSchedule,
      nextRefreshAt,
      id: existing.id,
      orgId: existing.orgId,
      slug: existing.slug,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    getDatabase()
      .update(toolboxes)
      .set({
        description: updated.description,
        // Force `null` (not `undefined`) so a cleared override actually
        // persists — drizzle skips `undefined` columns on update.
        source: updated.source ?? null,
        build: updated.build,
        paths: updated.paths,
        harness: updated.harness ?? null,
        processes: updated.processes,
        ports: updated.ports,
        files: updated.files,
        autoInject: updated.autoInject ? 1 : 0,
        refresh: updated.refresh,
        refreshSchedule: updated.refreshSchedule ?? null,
        nextRefreshAt: updated.nextRefreshAt ?? null,
        updatedAt: updated.updatedAt,
      })
      .where(eq(toolboxes.id, id))
      .run();
    return updated;
  }

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;
    getDatabase().delete(toolboxes).where(eq(toolboxes.id, id)).run();
    return true;
  }

  /** The pinned toolbox-version pointer (docs/toolbox-versions.md §2) — an
   * internal control concern kept off `ToolboxConfig`, exposed only via the
   * versions endpoint. */
  getActiveVersionId(toolboxId: string): string | null {
    const row = getDatabase()
      .select({ activeVersionId: toolboxes.activeVersionId })
      .from(toolboxes)
      .where(eq(toolboxes.id, toolboxId))
      .get();
    return row?.activeVersionId ?? null;
  }

  setActiveVersionId(toolboxId: string, versionId: string | null): void {
    getDatabase()
      .update(toolboxes)
      .set({ activeVersionId: versionId })
      .where(eq(toolboxes.id, toolboxId))
      .run();
  }
}
