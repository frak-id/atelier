import type { SandboxSpec } from "@atelier/spec";
import { eq, inArray, isNull, or } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { savedSpecs } from "../../db/schema.ts";

export interface SavedSpec {
  id: string;
  orgId?: string;
  name: string;
  spec: SandboxSpec;
  policyRefs: string[];
  createdAt: string;
  updatedAt: string;
}

function rowToSavedSpec(row: typeof savedSpecs.$inferSelect): SavedSpec {
  return {
    id: row.id,
    orgId: row.orgId ?? undefined,
    name: row.name,
    spec: row.spec,
    policyRefs: row.policyRefs,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The workspace replacement's storage: `{name, orgId, spec, policyRefs}`
 * (atelier-v2 §3.1 table). "Workspace definition" = editing a saved spec.
 */
export class SavedSpecRepository {
  getAll(): SavedSpec[] {
    return getDatabase().select().from(savedSpecs).all().map(rowToSavedSpec);
  }

  getByOrgId(orgId: string): SavedSpec[] {
    return getDatabase()
      .select()
      .from(savedSpecs)
      .where(eq(savedSpecs.orgId, orgId))
      .all()
      .map(rowToSavedSpec);
  }

  /** Org-scoped specs across multiple orgs, plus org-less ones. */
  getByOrgIds(orgIds: string[]): SavedSpec[] {
    const condition =
      orgIds.length > 0
        ? or(isNull(savedSpecs.orgId), inArray(savedSpecs.orgId, orgIds))
        : isNull(savedSpecs.orgId);
    return getDatabase()
      .select()
      .from(savedSpecs)
      .where(condition)
      .all()
      .map(rowToSavedSpec);
  }

  getById(id: string): SavedSpec | undefined {
    const row = getDatabase()
      .select()
      .from(savedSpecs)
      .where(eq(savedSpecs.id, id))
      .get();
    return row ? rowToSavedSpec(row) : undefined;
  }

  create(record: SavedSpec): SavedSpec {
    getDatabase()
      .insert(savedSpecs)
      .values({
        id: record.id,
        orgId: record.orgId,
        name: record.name,
        spec: record.spec,
        policyRefs: record.policyRefs,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
      .run();
    return record;
  }

  update(id: string, patch: Partial<SavedSpec>): SavedSpec | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;
    const updated: SavedSpec = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    getDatabase()
      .update(savedSpecs)
      .set({
        name: updated.name,
        spec: updated.spec,
        policyRefs: updated.policyRefs,
        updatedAt: updated.updatedAt,
      })
      .where(eq(savedSpecs.id, id))
      .run();
    return updated;
  }

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;
    getDatabase().delete(savedSpecs).where(eq(savedSpecs.id, id)).run();
    return true;
  }
}
