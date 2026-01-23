import { nanoid } from "nanoid";
import type {
  CreateTaskBody,
  Task,
  TaskStatus,
  UpdateTaskBody,
} from "../../schemas/index.ts";
import { NotFoundError, ValidationError } from "../../shared/errors.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { TaskRepository } from "./task.repository.ts";

const log = createChildLogger("task-service");

const MAX_ACTIVE_TASKS = 3;
const ACTIVE_STATUSES: TaskStatus[] = ["in_progress", "pending_review"];

export class TaskService {
  constructor(private readonly repository: TaskRepository) {}

  getAll(): Task[] {
    return this.repository.getAll();
  }

  getByWorkspaceId(workspaceId: string): Task[] {
    return this.repository.getByWorkspaceId(workspaceId);
  }

  getById(id: string): Task | undefined {
    return this.repository.getById(id);
  }

  getByIdOrThrow(id: string): Task {
    const task = this.repository.getById(id);
    if (!task) throw new NotFoundError("Task", id);
    return task;
  }

  create(body: CreateTaskBody): Task {
    const now = new Date().toISOString();
    const order = this.repository.getNextOrder(body.workspaceId, "draft");

    const task: Task = {
      id: `task_${nanoid(12)}`,
      workspaceId: body.workspaceId,
      title: body.title,
      status: "draft",
      data: {
        description: body.description,
        context: body.context,
        order,
        baseBranch: body.baseBranch,
        targetRepoIndices: body.targetRepoIndices,
      },
      createdAt: now,
      updatedAt: now,
    };

    return this.repository.create(task);
  }

  update(id: string, body: UpdateTaskBody): Task {
    const task = this.getByIdOrThrow(id);

    if (task.status !== "draft") {
      throw new ValidationError("Can only edit tasks in draft status");
    }

    const updates: Partial<Task> = {};
    if (body.title !== undefined) updates.title = body.title;
    if (body.description !== undefined || body.context !== undefined) {
      updates.data = {
        ...task.data,
        ...(body.description !== undefined && {
          description: body.description,
        }),
        ...(body.context !== undefined && { context: body.context }),
      };
    }

    return this.repository.update(id, updates);
  }

  async startTask(id: string): Promise<Task> {
    const task = this.getByIdOrThrow(id);

    if (task.status !== "draft") {
      throw new ValidationError("Can only start tasks in draft status");
    }

    if (!task.title.trim() || !task.data.description?.trim()) {
      throw new ValidationError("Task must have a title and description");
    }

    const activeCount = this.repository.countByStatuses(
      task.workspaceId,
      ACTIVE_STATUSES,
    );
    if (activeCount >= MAX_ACTIVE_TASKS) {
      throw new ValidationError(
        `Maximum ${MAX_ACTIVE_TASKS} active tasks (in progress + pending review). Complete or cancel existing tasks first.`,
      );
    }

    const order = this.repository.getNextOrder(task.workspaceId, "queue");
    const updated = this.repository.update(id, {
      status: "queue",
      data: { ...task.data, order },
    });

    log.info({ taskId: id, title: task.title }, "Task queued for execution");

    return updated;
  }

  moveToInProgress(
    id: string,
    sandboxId: string,
    sessionId: string,
    branchName?: string,
  ): Task {
    const task = this.getByIdOrThrow(id);

    if (task.status !== "queue") {
      throw new ValidationError("Task must be in queue to move to in_progress");
    }

    const order = this.repository.getNextOrder(task.workspaceId, "in_progress");
    return this.repository.update(id, {
      status: "in_progress",
      data: {
        ...task.data,
        sandboxId,
        opencodeSessionId: sessionId,
        startedAt: new Date().toISOString(),
        order,
        ...(branchName && { branchName }),
      },
    });
  }

  moveToReview(id: string): Task {
    const task = this.getByIdOrThrow(id);

    if (task.status !== "in_progress") {
      throw new ValidationError("Can only move in_progress tasks to review");
    }

    const order = this.repository.getNextOrder(
      task.workspaceId,
      "pending_review",
    );
    return this.repository.update(id, {
      status: "pending_review",
      data: { ...task.data, order },
    });
  }

  complete(id: string): Task {
    const task = this.getByIdOrThrow(id);

    if (task.status !== "pending_review") {
      throw new ValidationError(
        "Can only complete tasks in pending_review status",
      );
    }

    const order = this.repository.getNextOrder(task.workspaceId, "completed");
    return this.repository.update(id, {
      status: "completed",
      data: {
        ...task.data,
        completedAt: new Date().toISOString(),
        order,
      },
    });
  }

  reorder(id: string, newOrder: number): Task {
    const task = this.getByIdOrThrow(id);
    return this.repository.update(id, {
      data: { ...task.data, order: newOrder },
    });
  }

  resetToDraft(id: string): Task {
    const task = this.getByIdOrThrow(id);

    const order = this.repository.getNextOrder(task.workspaceId, "draft");
    return this.repository.update(id, {
      status: "draft",
      data: {
        description: task.data.description,
        context: task.data.context,
        order,
        baseBranch: task.data.baseBranch,
        targetRepoIndices: task.data.targetRepoIndices,
      },
    });
  }

  delete(id: string): boolean {
    const task = this.repository.getById(id);
    if (!task) return false;

    return this.repository.delete(id);
  }
}
