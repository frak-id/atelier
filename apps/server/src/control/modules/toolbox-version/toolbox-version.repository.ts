import type { ToolboxVersion } from "@atelier/spec";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { toolboxVersions } from "../../db/schema.ts";

function rowToVersion(
  row: typeof toolboxVersions.$inferSelect,
): ToolboxVersion {
  return {
    id: row.id,
    toolboxId: row.toolboxId,
    label: row.label,
    ref: row.ref,
    description: row.description,
    provenance: row.provenance,
    recipeFingerprint: row.recipeFingerprint,
    createdAt: row.createdAt,
  };
}

export class ToolboxVersionRepository {
  listByToolbox(toolboxId: string): ToolboxVersion[] {
    return getDatabase()
      .select()
      .from(toolboxVersions)
      .where(eq(toolboxVersions.toolboxId, toolboxId))
      .orderBy(asc(toolboxVersions.label))
      .all()
      .map(rowToVersion);
  }

  getById(id: string): ToolboxVersion | undefined {
    const row = getDatabase()
      .select()
      .from(toolboxVersions)
      .where(eq(toolboxVersions.id, id))
      .get();
    return row ? rowToVersion(row) : undefined;
  }

  /** Lookup used by the lazy `built`-row recorder (docs/toolbox-versions.md
   * §3) to check "has this exact artifact ref already been recorded for this
   * toolbox" before inserting. */
  getByToolboxAndRef(
    toolboxId: string,
    ref: string,
  ): ToolboxVersion | undefined {
    const row = getDatabase()
      .select()
      .from(toolboxVersions)
      .where(
        and(
          eq(toolboxVersions.toolboxId, toolboxId),
          eq(toolboxVersions.ref, ref),
        ),
      )
      .get();
    return row ? rowToVersion(row) : undefined;
  }

  create(record: ToolboxVersion): ToolboxVersion {
    getDatabase()
      .insert(toolboxVersions)
      .values({
        id: record.id,
        toolboxId: record.toolboxId,
        label: record.label,
        ref: record.ref,
        description: record.description,
        provenance: record.provenance,
        recipeFingerprint: record.recipeFingerprint,
        createdAt: record.createdAt,
      })
      .run();
    return record;
  }

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;
    getDatabase()
      .delete(toolboxVersions)
      .where(eq(toolboxVersions.id, id))
      .run();
    return true;
  }

  /** `max(label)+1` for this toolbox, or 1 if it has none yet — a per-toolbox
   * monotonic counter, not a global sequence (docs/toolbox-versions.md §4). */
  nextLabel(toolboxId: string): number {
    const row = getDatabase()
      .select({ max: sql<number | null>`max(${toolboxVersions.label})` })
      .from(toolboxVersions)
      .where(eq(toolboxVersions.toolboxId, toolboxId))
      .get();
    return (row?.max ?? 0) + 1;
  }
}
