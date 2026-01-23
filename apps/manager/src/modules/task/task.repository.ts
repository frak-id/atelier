import { and, eq, inArray, sql } from "drizzle-orm";
import { getDatabase, tasks } from "../../infrastructure/database/index.ts";
import type { Task, TaskData, TaskStatus } from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("task-repository");

function rowToTask(row: typeof tasks.$inferSelect): Task {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    status: row.status,
    data: row.data,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class TaskRepository {
  getAll(): Task[] {
    return getDatabase().select().from(tasks).all().map(rowToTask);
  }

  getByWorkspaceId(workspaceId: string): Task[] {
    return getDatabase()
      .select()
      .from(tasks)
      .where(eq(tasks.workspaceId, workspaceId))
      .all()
      .map(rowToTask);
  }

  getById(id: string): Task | undefined {
    const row = getDatabase()
      .select()
      .from(tasks)
      .where(eq(tasks.id, id))
      .get();
    return row ? rowToTask(row) : undefined;
  }

  countByStatuses(workspaceId: string, statuses: TaskStatus[]): number {
    const result = getDatabase()
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          inArray(tasks.status, statuses),
        ),
      )
      .get();
    return result?.count ?? 0;
  }

  create(task: Task): Task {
    getDatabase()
      .insert(tasks)
      .values({
        id: task.id,
        workspaceId: task.workspaceId,
        title: task.title,
        status: task.status,
        data: task.data,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      })
      .run();
    log.info({ taskId: task.id, title: task.title }, "Task created");
    return task;
  }

  update(id: string, updates: Partial<Omit<Task, "id" | "createdAt">>): Task {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Task '${id}' not found`);

    const updated: Task = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    getDatabase()
      .update(tasks)
      .set({
        title: updated.title,
        status: updated.status,
        data: updated.data,
        updatedAt: updated.updatedAt,
      })
      .where(eq(tasks.id, id))
      .run();

    log.debug({ taskId: id, status: updated.status }, "Task updated");
    return updated;
  }

  updateStatus(id: string, status: TaskStatus): Task {
    return this.update(id, { status });
  }

  updateData(id: string, dataUpdates: Partial<TaskData>): Task {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Task '${id}' not found`);

    return this.update(id, {
      data: { ...existing.data, ...dataUpdates },
    });
  }

  delete(id: string): boolean {
    const existing = this.getById(id);
    if (!existing) return false;

    getDatabase().delete(tasks).where(eq(tasks.id, id)).run();
    log.info({ taskId: id }, "Task deleted");
    return true;
  }

  getNextOrder(workspaceId: string, status: TaskStatus): number {
    const result = getDatabase()
      .select({
        maxOrder: sql<number>`COALESCE(MAX(json_extract(data, '$.order')), -1)`,
      })
      .from(tasks)
      .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, status)))
      .get();
    return (result?.maxOrder ?? -1) + 1;
  }
}
