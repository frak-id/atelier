import { eventBus } from "../../infrastructure/events/index.ts";
import type {
  CreateTaskBody,
  Task,
  TaskSession,
  UpdateTaskBody,
} from "../../schemas/index.ts";
import { NotFoundError, ValidationError } from "../../shared/errors.ts";
import { config } from "../../shared/lib/config.ts";
import { safeNanoid } from "../../shared/lib/id.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import type { TaskRepository } from "./task.repository.ts";

const log = createChildLogger("task-service");

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

  create(body: CreateTaskBody & { title: string }): Task {
    const now = new Date().toISOString();
    const order = this.repository.getNextOrder(body.workspaceId, "draft");

    const task: Task = {
      id: `task_${safeNanoid(12)}`,
      workspaceId: body.workspaceId,
      title: body.title,
      status: "draft",
      data: {
        description: body.description,
        workflowId: body.workflowId,
        variantIndex: body.variantIndex,
        order,
        baseBranch: body.baseBranch,
        targetRepoIndices: body.targetRepoIndices,
        sessions: [],
      },
      createdAt: now,
      updatedAt: now,
    };

    const created = this.repository.create(task);
    eventBus.emit({
      type: "task.created",
      properties: { id: created.id, workspaceId: created.workspaceId },
    });
    return created;
  }

  update(id: string, body: UpdateTaskBody): Task {
    const task = this.getByIdOrThrow(id);

    if (task.status !== "draft") {
      throw new ValidationError("Can only edit tasks in draft status");
    }

    const updates: Partial<Task> = {};
    if (body.title !== undefined) updates.title = body.title;
    if (
      body.description !== undefined ||
      body.workflowId !== undefined ||
      body.variantIndex !== undefined
    ) {
      updates.data = {
        ...task.data,
        ...(body.description !== undefined && {
          description: body.description,
        }),
        ...(body.workflowId !== undefined && { workflowId: body.workflowId }),
        ...(body.variantIndex !== undefined && {
          variantIndex: body.variantIndex,
        }),
      };
    }

    const updated = this.repository.update(id, updates);
    eventBus.emit({
      type: "task.updated",
      properties: { id, workspaceId: updated.workspaceId },
    });
    return updated;
  }

  async startTask(id: string): Promise<Task> {
    const task = this.getByIdOrThrow(id);

    if (task.status !== "draft") {
      throw new ValidationError("Can only start tasks in draft status");
    }

    if (!task.data.description?.trim()) {
      throw new ValidationError("Task must have a description");
    }

    const activeCount = this.repository.countByStatuses(task.workspaceId, [
      "active",
    ]);
    if (activeCount >= config.server.maxActiveTasks) {
      throw new ValidationError(
        `Maximum ${config.server.maxActiveTasks} active tasks. Complete or cancel existing tasks first.`,
      );
    }

    const order = this.repository.getNextOrder(task.workspaceId, "active");
    const updated = this.repository.update(id, {
      status: "active",
      data: { ...task.data, order, startedAt: new Date().toISOString() },
    });

    eventBus.emit({
      type: "task.updated",
      properties: { id, workspaceId: updated.workspaceId },
    });
    log.info({ taskId: id, title: task.title }, "Task started");

    return updated;
  }

  attachSandbox(id: string, sandboxId: string, branchName?: string): Task {
    const task = this.getByIdOrThrow(id);

    if (task.status !== "active") {
      throw new ValidationError("Task must be active to attach sandbox");
    }

    const updated = this.repository.update(id, {
      data: {
        ...task.data,
        sandboxId,
        ...(branchName && { branchName }),
      },
    });
    eventBus.emit({
      type: "task.updated",
      properties: { id, workspaceId: updated.workspaceId },
    });
    return updated;
  }

  addSession(
    id: string,
    sessionId: string,
    sessionTemplateId: string,
  ): { task: Task; session: TaskSession } {
    const task = this.getByIdOrThrow(id);

    if (task.status !== "active") {
      throw new ValidationError("Task must be active to add sessions");
    }

    const sessions = task.data.sessions ?? [];
    const nextOrder = sessions.length;

    const newSession: TaskSession = {
      id: sessionId,
      templateId: sessionTemplateId,
      order: nextOrder,
      startedAt: new Date().toISOString(),
    };

    const updatedTask = this.repository.update(id, {
      data: {
        ...task.data,
        sessions: [...sessions, newSession],
      },
    });

    eventBus.emit({
      type: "task.updated",
      properties: { id, workspaceId: updatedTask.workspaceId },
    });
    log.info(
      { taskId: id, sessionId, templateId: sessionTemplateId },
      "Session added to task",
    );

    return { task: updatedTask, session: newSession };
  }

  complete(id: string): Task {
    const task = this.getByIdOrThrow(id);

    if (task.status !== "active") {
      throw new ValidationError("Can only complete active tasks");
    }

    const order = this.repository.getNextOrder(task.workspaceId, "done");
    const updated = this.repository.update(id, {
      status: "done",
      data: {
        ...task.data,
        completedAt: new Date().toISOString(),
        order,
      },
    });
    eventBus.emit({
      type: "task.updated",
      properties: { id, workspaceId: updated.workspaceId },
    });
    return updated;
  }

  findByIntegrationKey(source: string, threadKey: string): Task | undefined {
    return this.repository.findByIntegrationKey(source, threadKey);
  }

  setIntegrationMetadata(
    id: string,
    integration: NonNullable<Task["data"]["integration"]>,
  ): Task {
    const task = this.getByIdOrThrow(id);
    const updated = this.repository.update(id, {
      data: { ...task.data, integration },
    });
    log.info(
      { taskId: id, source: integration.source },
      "Integration metadata set",
    );
    return updated;
  }

  setIntegrationSessionId(id: string, sessionId: string): Task {
    const task = this.getByIdOrThrow(id);
    if (!task.data.integration) {
      throw new ValidationError("Task has no integration metadata");
    }
    return this.repository.update(id, {
      data: {
        ...task.data,
        integration: { ...task.data.integration, sessionId },
      },
    });
  }

  updateTitle(id: string, title: string): Task {
    this.getByIdOrThrow(id);
    const updated = this.repository.update(id, { title });
    eventBus.emit({
      type: "task.updated",
      properties: { id, workspaceId: updated.workspaceId },
    });
    log.info({ taskId: id, title }, "Task title updated");
    return updated;
  }

  reorder(id: string, newOrder: number): Task {
    const task = this.getByIdOrThrow(id);
    const updated = this.repository.update(id, {
      data: { ...task.data, order: newOrder },
    });
    eventBus.emit({
      type: "task.updated",
      properties: { id, workspaceId: updated.workspaceId },
    });
    return updated;
  }

  resetToDraft(id: string): Task {
    const task = this.getByIdOrThrow(id);

    const order = this.repository.getNextOrder(task.workspaceId, "draft");
    const updated = this.repository.update(id, {
      status: "draft",
      data: {
        description: task.data.description,
        workflowId: task.data.workflowId,
        variantIndex: task.data.variantIndex,
        order,
        baseBranch: task.data.baseBranch,
        targetRepoIndices: task.data.targetRepoIndices,
        sessions: [],
      },
    });
    eventBus.emit({
      type: "task.updated",
      properties: { id, workspaceId: updated.workspaceId },
    });
    return updated;
  }

  delete(id: string): boolean {
    const task = this.getByIdOrThrow(id);
    const result = this.repository.delete(id);
    if (result) {
      eventBus.emit({
        type: "task.deleted",
        properties: { id, workspaceId: task.workspaceId },
      });
    }
    return result;
  }
}
