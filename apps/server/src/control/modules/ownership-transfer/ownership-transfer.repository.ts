import type { CreateSandboxRequest, ToolboxOwner } from "@atelier/spec";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import {
  entityToolboxes,
  entityToolboxVersions,
  launchpadStarters,
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

export interface TransferStarterRow {
  id: string;
  title: string;
  published: boolean;
  recipe: CreateSandboxRequest;
}

/** Everything one transfer writes, applied atomically by `apply`. */
export interface TransferWrite {
  from: ToolboxOwner;
  toOrgId: string;
  secretIds: string[];
  policyIds: string[];
  toolboxIds: string[];
  starterIds: string[];
  /** Starters (any owner) whose recipe selectors point at a moved toolbox. */
  recipeRewrites: { id: string; recipe: CreateSandboxRequest }[];
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
 * org policy, toolboxes and starters, and must land all-or-nothing.
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

  listStarters(owner?: ToolboxOwner): TransferStarterRow[] {
    return getDatabase()
      .select({
        id: launchpadStarters.id,
        title: launchpadStarters.title,
        published: launchpadStarters.published,
        recipe: launchpadStarters.recipe,
      })
      .from(launchpadStarters)
      .where(
        owner
          ? and(
              eq(launchpadStarters.ownerType, owner.type),
              eq(launchpadStarters.ownerId, owner.id),
            )
          : undefined,
      )
      .orderBy(asc(launchpadStarters.createdAt))
      .all()
      .map((row) => ({ ...row, published: row.published === 1 }));
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
      if (write.starterIds.length > 0) {
        tx.update(launchpadStarters)
          .set({ ownerType: "org", ownerId: write.toOrgId, updatedAt: now })
          .where(
            and(
              eq(launchpadStarters.ownerType, from.type),
              eq(launchpadStarters.ownerId, from.id),
              inArray(launchpadStarters.id, write.starterIds),
            ),
          )
          .run();
      }
      for (const { id, recipe } of write.recipeRewrites) {
        tx.update(launchpadStarters)
          .set({ recipe, updatedAt: now })
          .where(eq(launchpadStarters.id, id))
          .run();
      }
    });
  }
}
