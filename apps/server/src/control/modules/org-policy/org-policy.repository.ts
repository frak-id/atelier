import { eq } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { orgPolicySpecs } from "../../db/schema.ts";

export interface OrgPolicySpec {
  id: string;
  orgId: string;
  fragment: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export class OrgPolicyRepository {
  getByOrgId(orgId: string): OrgPolicySpec | undefined {
    return getDatabase()
      .select()
      .from(orgPolicySpecs)
      .where(eq(orgPolicySpecs.orgId, orgId))
      .get();
  }

  upsert(record: OrgPolicySpec): OrgPolicySpec {
    const db = getDatabase();
    const existing = this.getByOrgId(record.orgId);
    if (existing) {
      db.update(orgPolicySpecs)
        .set({ fragment: record.fragment, updatedAt: record.updatedAt })
        .where(eq(orgPolicySpecs.id, existing.id))
        .run();
      return { ...existing, ...record };
    }
    db.insert(orgPolicySpecs).values(record).run();
    return record;
  }
}
