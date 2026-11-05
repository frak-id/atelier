import { and, asc, eq, inArray } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { secrets, toolboxes, toolboxVersions } from "../../db/schema.ts";

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
  fromOrgId: string;
  toOrgId: string;
  secretIds: string[];
  toolboxIds: string[];
}

/**
 * Reads + the one atomic write behind an ownership transfer. Spans several
 * modules' tables on purpose: a transfer is a unit of work across secrets
 * and toolboxes, and must land all-or-nothing.
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

  listToolboxes(orgId: string): TransferToolboxRow[] {
    return getDatabase()
      .select({
        id: toolboxes.id,
        slug: toolboxes.slug,
        autoInject: toolboxes.autoInject,
        activeVersionRef: toolboxVersions.ref,
        activeVersionLabel: toolboxVersions.label,
      })
      .from(toolboxes)
      .leftJoin(
        toolboxVersions,
        eq(toolboxVersions.id, toolboxes.activeVersionId),
      )
      .where(eq(toolboxes.orgId, orgId))
      .orderBy(asc(toolboxes.createdAt))
      .all()
      .map((row) => ({ ...row, autoInject: row.autoInject === 1 }));
  }

  /** Apply a validated transfer in one SQLite transaction: any failure rolls
   * every row back, so a transfer never lands half-done. */
  apply(write: TransferWrite): void {
    const now = new Date().toISOString();
    const { fromOrgId } = write;
    // Every move re-checks the source org in SQL too (not only in the
    // service's plan), so this write can never move someone else's rows.
    getDatabase().transaction((tx) => {
      if (write.secretIds.length > 0) {
        tx.update(secrets)
          .set({ orgId: write.toOrgId, updatedAt: now })
          .where(
            and(
              eq(secrets.orgId, fromOrgId),
              inArray(secrets.id, write.secretIds),
            ),
          )
          .run();
      }
      if (write.toolboxIds.length > 0) {
        tx.update(toolboxes)
          .set({ orgId: write.toOrgId, updatedAt: now })
          .where(
            and(
              eq(toolboxes.orgId, fromOrgId),
              inArray(toolboxes.id, write.toolboxIds),
            ),
          )
          .run();
      }
    });
  }
}
