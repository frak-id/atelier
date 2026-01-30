import { and, eq, inArray, sql } from "drizzle-orm";
import {
  getDatabase,
  slackThreads,
} from "../../infrastructure/database/index.ts";
import type {
  SlackThread,
  SlackThreadData,
  SlackThreadStatus,
} from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("slack-thread-repository");

function rowToSlackThread(row: typeof slackThreads.$inferSelect): SlackThread {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    sandboxId: row.sandboxId ?? undefined,
    sessionId: row.sessionId ?? undefined,
    channelId: row.channelId,
    threadTs: row.threadTs,
    userId: row.userId,
    userName: row.userName ?? undefined,
    initialMessage: row.initialMessage,
    branchName: row.branchName ?? undefined,
    status: row.status,
    data: row.data,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class SlackThreadRepository {
  getAll(): SlackThread[] {
    return getDatabase()
      .select()
      .from(slackThreads)
      .all()
      .map(rowToSlackThread);
  }

  getByWorkspaceId(workspaceId: string): SlackThread[] {
    return getDatabase()
      .select()
      .from(slackThreads)
      .where(eq(slackThreads.workspaceId, workspaceId))
      .all()
      .map(rowToSlackThread);
  }

  getById(id: string): SlackThread | undefined {
    const row = getDatabase()
      .select()
      .from(slackThreads)
      .where(eq(slackThreads.id, id))
      .get();
    return row ? rowToSlackThread(row) : undefined;
  }

  getByThreadKey(channelId: string, threadTs: string): SlackThread | undefined {
    const row = getDatabase()
      .select()
      .from(slackThreads)
      .where(
        and(
          eq(slackThreads.channelId, channelId),
          eq(slackThreads.threadTs, threadTs),
        ),
      )
      .get();
    return row ? rowToSlackThread(row) : undefined;
  }

  getByStatus(status: SlackThreadStatus): SlackThread[] {
    return getDatabase()
      .select()
      .from(slackThreads)
      .where(eq(slackThreads.status, status))
      .all()
      .map(rowToSlackThread);
  }

  getActive(): SlackThread[] {
    return getDatabase()
      .select()
      .from(slackThreads)
      .where(inArray(slackThreads.status, ["spawning", "active"]))
      .all()
      .map(rowToSlackThread);
  }

  countActiveByWorkspaceId(workspaceId: string): number {
    const result = getDatabase()
      .select({ count: sql<number>`count(*)` })
      .from(slackThreads)
      .where(
        and(
          eq(slackThreads.workspaceId, workspaceId),
          inArray(slackThreads.status, ["spawning", "active"]),
        ),
      )
      .get();
    return result?.count ?? 0;
  }

  create(thread: SlackThread): SlackThread {
    getDatabase()
      .insert(slackThreads)
      .values({
        id: thread.id,
        workspaceId: thread.workspaceId,
        sandboxId: thread.sandboxId,
        sessionId: thread.sessionId,
        channelId: thread.channelId,
        threadTs: thread.threadTs,
        userId: thread.userId,
        userName: thread.userName,
        initialMessage: thread.initialMessage,
        branchName: thread.branchName,
        status: thread.status,
        data: thread.data,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      })
      .run();
    log.info({ threadId: thread.id }, "Slack thread created");
    return thread;
  }

  update(
    id: string,
    updates: Partial<Omit<SlackThread, "id" | "createdAt">>,
  ): SlackThread {
    const existing = this.getById(id);
    if (!existing) throw new Error(`SlackThread '${id}' not found`);

    const updated: SlackThread = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    getDatabase()
      .update(slackThreads)
      .set({
        workspaceId: updated.workspaceId,
        sandboxId: updated.sandboxId,
        sessionId: updated.sessionId,
        channelId: updated.channelId,
        threadTs: updated.threadTs,
        userId: updated.userId,
        userName: updated.userName,
        initialMessage: updated.initialMessage,
        branchName: updated.branchName,
        status: updated.status,
        data: updated.data,
        updatedAt: updated.updatedAt,
      })
      .where(eq(slackThreads.id, id))
      .run();

    log.debug({ threadId: id, status: updated.status }, "Slack thread updated");
    return updated;
  }

  updateStatus(id: string, status: string): SlackThread {
    return this.update(id, { status });
  }

  updateData(id: string, dataUpdates: Partial<SlackThreadData>): SlackThread {
    const existing = this.getById(id);
    if (!existing) throw new Error(`SlackThread '${id}' not found`);

    return this.update(id, {
      data: { ...existing.data, ...dataUpdates },
    });
  }

  delete(id: string): void {
    getDatabase().delete(slackThreads).where(eq(slackThreads.id, id)).run();
    log.info({ threadId: id }, "Slack thread deleted");
  }
}
