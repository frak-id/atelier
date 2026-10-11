import type { SteeryNotifyPolicy } from "@frak/atelier-shared";
import { eq } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { steeryNotifyPolicies } from "../../db/schema.ts";

export class SteeryNotifyRepository {
  get(orgId: string): SteeryNotifyPolicy | undefined {
    return getDatabase()
      .select()
      .from(steeryNotifyPolicies)
      .where(eq(steeryNotifyPolicies.orgId, orgId))
      .get()?.policy;
  }

  set(orgId: string, policy: SteeryNotifyPolicy): void {
    const updatedAt = new Date().toISOString();
    getDatabase()
      .insert(steeryNotifyPolicies)
      .values({ orgId, policy, updatedAt })
      .onConflictDoUpdate({
        target: steeryNotifyPolicies.orgId,
        set: { policy, updatedAt },
      })
      .run();
  }
}
