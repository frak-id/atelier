import type {
  SandboxSpec,
  TemplateComposition,
  TemplateMeta,
  TemplateParam,
} from "@atelier/spec";
import { eq, inArray, isNull, or } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { savedSpecs } from "../../db/schema.ts";

export type { TemplateComposition, TemplateMeta, TemplateParam };

export interface SavedSpec {
  id: string;
  orgId?: string;
  name: string;
  spec: SandboxSpec;
  policyRefs: string[];
  /** Published to the gallery (design ui-evolution.md §2.1). */
  template: boolean;
  meta: TemplateMeta | null;
  /** Build recipe (prebuild + toolbox selectors) resolved at spawn so the
   * template follows updates rather than pinning refs. */
  composition: TemplateComposition | null;
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
    template: row.template === "true",
    meta: row.meta ?? null,
    composition: row.composition ?? null,
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
        template: record.template ? "true" : "false",
        meta: record.meta,
        composition: record.composition,
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
        template: updated.template ? "true" : "false",
        meta: updated.meta,
        composition: updated.composition,
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
