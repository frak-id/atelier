import type { WorkspaceSnapshot } from "@atelier/spec";
import { desc, eq } from "drizzle-orm";
import { getDatabase } from "../../db/client.ts";
import { launchpadWorkspaces } from "../../db/schema.ts";

/** A Launchpad workspace row: the user's words about a sandbox they
 * launched from a starter. Keyed by the sandbox id (no FK to runtime). */
export interface WorkspaceRecord {
  sandboxId: string;
  userId: string;
  starterId?: string;
  jobId?: string;
  title: string;
  description: string;
  snapshot: WorkspaceSnapshot;
  createdAt: string;
  updatedAt: string;
}

type WorkspaceRow = typeof launchpadWorkspaces.$inferSelect;

function rowToRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    sandboxId: row.sandboxId,
    userId: row.userId,
    ...(row.starterId ? { starterId: row.starterId } : {}),
    ...(row.jobId ? { jobId: row.jobId } : {}),
    title: row.title,
    description: row.description,
    snapshot: row.snapshot,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class WorkspaceRepository {
  /** Most recently touched first — the "jump back in" order. */
  listByUser(userId: string): WorkspaceRecord[] {
    return getDatabase()
      .select()
      .from(launchpadWorkspaces)
      .where(eq(launchpadWorkspaces.userId, userId))
      .orderBy(desc(launchpadWorkspaces.updatedAt))
      .all()
      .map(rowToRecord);
  }

  get(sandboxId: string): WorkspaceRecord | undefined {
    const row = getDatabase()
      .select()
      .from(launchpadWorkspaces)
      .where(eq(launchpadWorkspaces.sandboxId, sandboxId))
      .get();
    return row ? rowToRecord(row) : undefined;
  }

  create(record: WorkspaceRecord): WorkspaceRecord {
    getDatabase()
      .insert(launchpadWorkspaces)
      .values({
        sandboxId: record.sandboxId,
        userId: record.userId,
        starterId: record.starterId ?? null,
        jobId: record.jobId ?? null,
        title: record.title,
        description: record.description,
        snapshot: record.snapshot,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
      .run();
    return record;
  }

  update(
    sandboxId: string,
    patch: Partial<
      Pick<WorkspaceRecord, "title" | "description" | "jobId" | "snapshot">
    >,
  ): void {
    getDatabase()
      .update(launchpadWorkspaces)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(eq(launchpadWorkspaces.sandboxId, sandboxId))
      .run();
  }

  delete(sandboxId: string): void {
    getDatabase()
      .delete(launchpadWorkspaces)
      .where(eq(launchpadWorkspaces.sandboxId, sandboxId))
      .run();
  }
}
