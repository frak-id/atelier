import type { ToolboxOwner } from "@atelier/spec";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import {
  entityToolboxes,
  entityToolboxVersions,
  orgPolicySpecs,
  secrets,
} from "../../db/schema.ts";

export interface TransferToolboxRow {
  id: string;
  slug: string;
  autoInject: boolean;
  /** The pinned version's artifact ref, when the toolbox is pinned. */
  activeVersionRef: string | null;
  activeVersionLabel: number | null;
}

/** Everything one transfer writes, applied atomically by `apply`. */
export interface TransferWrite {
  from: ToolboxOwner;
  toOrgId: string;
  secretIds: string[];
  policyIds: string[];
  toolboxIds: string[];
}

function toolboxOwnerFilter(owner: ToolboxOwner) {
  return and(
    eq(entityToolboxes.ownerType, owner.type),
    eq(entityToolboxes.ownerId, owner.id),
  );
}

/**
 * Reads + the one atomic write behind an ownership transfer. Spans several
 * modules' tables on purpose: a transfer is a unit of work across secrets,
 * org policy and toolboxes, and must land all-or-nothing.
 */
export class OwnershipTransferRepository {
  listSecrets(orgId: string): { id: string; name: string }[] {
    return getDatabase()
      .select({ id: secrets.id, name: secrets.name })
      .from(secrets)
      .where(eq(secrets.orgId, orgId))
      .orderBy(asc(secrets.name))
      .all();
  }

  getPolicyId(orgId: string): string | undefined {
    return getDatabase()
      .select({ id: orgPolicySpecs.id })
      .from(orgPolicySpecs)
      .where(eq(orgPolicySpecs.orgId, orgId))
      .get()?.id;
  }

  listToolboxes(owner: ToolboxOwner): TransferToolboxRow[] {
    return getDatabase()
      .select({
        id: entityToolboxes.id,
        slug: entityToolboxes.slug,
        autoInject: entityToolboxes.autoInject,
        activeVersionRef: entityToolboxVersions.ref,
        activeVersionLabel: entityToolboxVersions.label,
      })
      .from(entityToolboxes)
      .leftJoin(
        entityToolboxVersions,
        eq(entityToolboxVersions.id, entityToolboxes.activeVersionId),
      )
      .where(toolboxOwnerFilter(owner))
      .orderBy(asc(entityToolboxes.createdAt))
      .all()
      .map((row) => ({ ...row, autoInject: row.autoInject === 1 }));
  }

  /** Apply a validated transfer in one SQLite transaction: any failure rolls
   * every row back, so a transfer never lands half-done. */
  apply(write: TransferWrite): void {
    const now = new Date().toISOString();
    const { from } = write;
    // Every move re-checks the source owner in SQL too (not only in the
    // service's plan), so this write can never move someone else's rows.
    getDatabase().transaction((tx) => {
      if (write.secretIds.length > 0 && from.type === "org") {
        tx.update(secrets)
          .set({ orgId: write.toOrgId, updatedAt: now })
          .where(
            and(
              eq(secrets.orgId, from.id),
              inArray(secrets.id, write.secretIds),
            ),
          )
          .run();
      }
      if (write.policyIds.length > 0 && from.type === "org") {
        tx.update(orgPolicySpecs)
          .set({ orgId: write.toOrgId, updatedAt: now })
          .where(
            and(
              eq(orgPolicySpecs.orgId, from.id),
              inArray(orgPolicySpecs.id, write.policyIds),
            ),
          )
          .run();
      }
      if (write.toolboxIds.length > 0) {
        tx.update(entityToolboxes)
          .set({ ownerType: "org", ownerId: write.toOrgId, updatedAt: now })
          .where(
            and(
              toolboxOwnerFilter(from),
              inArray(entityToolboxes.id, write.toolboxIds),
            ),
          )
          .run();
      }
    });
  }
}
