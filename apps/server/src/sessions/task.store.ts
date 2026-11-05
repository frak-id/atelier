/**
 * Persistence for agent tasks (`agent_tasks`, sessions/db/schema.ts). The
 * service keeps live state (open session, transcript) in memory and writes
 * the durable part through this store, so a restart brings tasks back parked.
 */
import { and, desc, eq, inArray, lt, type SQL } from "drizzle-orm";
import { getDatabase } from "../shared/lib/db.ts";
import { agentTasks } from "./db/schema.ts";

/** A task's status. `closed` is never stored: closing deletes the row. */
export type StoredTaskStatus = "running" | "idle" | "failed" | "cancelled";

/** Git state of the sandbox's working directory at the end of a turn. Every
 * field is best effort: absent when git said nothing. */
export interface TaskResult {
  branch?: string;
  headSha?: string;
  /** Commits ahead of the branch's upstream. */
  commitsAhead?: number;
  /** `git diff --shortstat HEAD`: uncommitted changes. */
  diffStat?: string;
  capturedAt: string;
}

export interface StoredTask {
  id: string;
  ownerId: string;
  sandboxId: string;
  sessionId: string;
  cwd: string;
  harness: string;
  status: StoredTaskStatus;
  title: string;
  source: "mcp" | "console";
  turnCount: number;
  lastPrompt: string;
  lastReply: string;
  lastError?: string;
  result?: TaskResult;
  createdAt: string;
  updatedAt: string;
}

export interface TaskListFilter {
  ownerId?: string;
  /** Only tasks of these sandboxes. */
  sandboxIds?: string[];
  status?: StoredTaskStatus;
  limit?: number;
}

export interface TaskStore {
  upsert(task: StoredTask): void;
  get(id: string): StoredTask | undefined;
  /** Newest first. */
  list(filter: TaskListFilter): StoredTask[];
  delete(id: string): void;
  /** Tasks left `running` by a previous process cannot be running: mark
   * them failed. */
  failInterrupted(message: string): void;
  /** Forget tasks last touched before `beforeIso`. */
  deleteUpdatedBefore(beforeIso: string): void;
}

type Row = typeof agentTasks.$inferSelect;

function toRow(task: StoredTask): Row {
  return {
    ...task,
    lastError: task.lastError ?? null,
    result: task.result ? JSON.stringify(task.result) : null,
  };
}

function fromRow(row: Row): StoredTask {
  const { lastError, result, status, source, ...rest } = row;
  return {
    ...rest,
    status: status as StoredTaskStatus,
    source: source as StoredTask["source"],
    ...(lastError !== null && { lastError }),
    ...(result !== null && { result: JSON.parse(result) as TaskResult }),
  };
}

export class DrizzleTaskStore implements TaskStore {
  upsert(task: StoredTask): void {
    const row = toRow(task);
    getDatabase()
      .insert(agentTasks)
      .values(row)
      .onConflictDoUpdate({ target: agentTasks.id, set: row })
      .run();
  }

  get(id: string): StoredTask | undefined {
    const row = getDatabase()
      .select()
      .from(agentTasks)
      .where(eq(agentTasks.id, id))
      .get();
    return row && fromRow(row);
  }

  list(filter: TaskListFilter): StoredTask[] {
    if (filter.sandboxIds?.length === 0) return [];
    const conditions: SQL[] = [];
    if (filter.ownerId) conditions.push(eq(agentTasks.ownerId, filter.ownerId));
    if (filter.sandboxIds) {
      conditions.push(inArray(agentTasks.sandboxId, filter.sandboxIds));
    }
    if (filter.status) conditions.push(eq(agentTasks.status, filter.status));
    const query = getDatabase()
      .select()
      .from(agentTasks)
      .where(and(...conditions))
      .orderBy(desc(agentTasks.createdAt));
    return (filter.limit === undefined ? query : query.limit(filter.limit))
      .all()
      .map(fromRow);
  }

  delete(id: string): void {
    getDatabase().delete(agentTasks).where(eq(agentTasks.id, id)).run();
  }

  failInterrupted(message: string): void {
    getDatabase()
      .update(agentTasks)
      .set({ status: "failed", lastError: message })
      .where(eq(agentTasks.status, "running"))
      .run();
  }

  deleteUpdatedBefore(beforeIso: string): void {
    getDatabase()
      .delete(agentTasks)
      .where(lt(agentTasks.updatedAt, beforeIso))
      .run();
  }
}
