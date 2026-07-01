import { safeNanoid } from "../../../shared/lib/id.ts";
import type {
  OrgPolicyRepository,
  OrgPolicySpec,
} from "./org-policy.repository.ts";

/**
 * Per-org operator-mandated spec fragment (an audit process, a compliance
 * file) appended at every seam crossing — the enforcement half of enrichment
 * (atelier-v2 §3.2). A dev hand-crafting a spec against the raw API still
 * gets these, because enrichment happens server-side on every crossing.
 */
export class OrgPolicyService {
  constructor(private readonly repository: OrgPolicyRepository) {}

  getByOrgId(orgId: string): OrgPolicySpec | undefined {
    return this.repository.getByOrgId(orgId);
  }

  set(orgId: string, fragment: Record<string, unknown>): OrgPolicySpec {
    const existing = this.repository.getByOrgId(orgId);
    const now = new Date().toISOString();
    return this.repository.upsert({
      id: existing?.id ?? safeNanoid(),
      orgId,
      fragment,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }
}
