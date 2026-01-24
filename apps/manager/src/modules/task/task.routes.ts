import { Elysia, t } from "elysia";
import {
  sessionMonitor,
  taskService,
  taskSpawner,
  taskTemplateService,
} from "../../container.ts";
import {
  CreateTaskBodySchema,
  DeleteTaskQuerySchema,
  IdParamSchema,
  ReorderTaskBodySchema,
  TaskListResponseSchema,
  TaskSchema,
  UpdateTaskBodySchema,
} from "../../schemas/index.ts";
import { ValidationError } from "../../shared/errors.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("task-routes");

export const taskRoutes = new Elysia({ prefix: "/tasks" })
  .get(
    "/",
    ({ query }) => {
      if (query.workspaceId) {
        return taskService.getByWorkspaceId(query.workspaceId);
      }
      return taskService.getAll();
    },
    {
      query: t.Object({
        workspaceId: t.Optional(t.String()),
      }),
      response: TaskListResponseSchema,
    },
  )
  .get(
    "/:id",
    ({ params }) => {
      return taskService.getByIdOrThrow(params.id);
    },
    {
      params: IdParamSchema,
      response: TaskSchema,
    },
  )
  .post(
    "/",
    ({ body, set }) => {
      log.info(
        { title: body.title, workspaceId: body.workspaceId },
        "Creating task",
      );

      if (body.variantIndex !== undefined && body.templateId) {
        const template = taskTemplateService.getTemplateById(
          body.templateId,
          body.workspaceId,
        );
        if (template && body.variantIndex >= template.variants.length) {
          throw new ValidationError(
            `Variant index ${body.variantIndex} out of range (max: ${template.variants.length - 1})`,
          );
        }
      }

      const task = taskService.create(body);
      set.status = 201;
      return task;
    },
    {
      body: CreateTaskBodySchema,
      response: TaskSchema,
    },
  )
  .put(
    "/:id",
    ({ params, body }) => {
      log.info({ taskId: params.id }, "Updating task");

      if (body.variantIndex !== undefined) {
        const task = taskService.getByIdOrThrow(params.id);
        const templateId = body.templateId ?? task.data.templateId;
        if (templateId) {
          const template = taskTemplateService.getTemplateById(
            templateId,
            task.workspaceId,
          );
          if (template && body.variantIndex >= template.variants.length) {
            throw new ValidationError(
              `Variant index ${body.variantIndex} out of range (max: ${template.variants.length - 1})`,
            );
          }
        }
      }

      return taskService.update(params.id, body);
    },
    {
      params: IdParamSchema,
      body: UpdateTaskBodySchema,
      response: TaskSchema,
    },
  )
  .post(
    "/:id/start",
    async ({ params, set }) => {
      log.info({ taskId: params.id }, "Starting task");
      const task = await taskService.startTask(params.id);

      taskSpawner.runInBackground(params.id);

      set.status = 202;
      return task;
    },
    {
      params: IdParamSchema,
      response: TaskSchema,
    },
  )
  .post(
    "/:id/review",
    ({ params }) => {
      log.info({ taskId: params.id }, "Moving task to review");
      return taskService.moveToReview(params.id);
    },
    {
      params: IdParamSchema,
      response: TaskSchema,
    },
  )
  .post(
    "/:id/complete",
    ({ params }) => {
      log.info({ taskId: params.id }, "Completing task");
      return taskService.complete(params.id);
    },
    {
      params: IdParamSchema,
      response: TaskSchema,
    },
  )
  .post(
    "/:id/reset",
    ({ params }) => {
      log.info({ taskId: params.id }, "Resetting task to draft");
      sessionMonitor.stopMonitoringTask(params.id);
      return taskService.resetToDraft(params.id);
    },
    {
      params: IdParamSchema,
      response: TaskSchema,
    },
  )
  .put(
    "/:id/order",
    ({ params, body }) => {
      return taskService.reorder(params.id, body.order);
    },
    {
      params: IdParamSchema,
      body: ReorderTaskBodySchema,
      response: TaskSchema,
    },
  )
  .delete(
    "/:id",
    async ({ params, query, set }) => {
      const task = taskService.getByIdOrThrow(params.id);
      const keepSandbox = query.keepSandbox === "true";

      log.info({ taskId: params.id, keepSandbox }, "Deleting task");

      sessionMonitor.stopMonitoringTask(params.id);

      if (task.data.sandboxId) {
        const { sandboxDestroyer, sandboxLifecycle } = await import(
          "../../container.ts"
        );

        if (keepSandbox) {
          await sandboxLifecycle.stop(task.data.sandboxId);
        } else {
          await sandboxDestroyer.destroy(task.data.sandboxId);
        }
      }

      taskService.delete(params.id);
      set.status = 204;
      return null;
    },
    {
      params: IdParamSchema,
      query: DeleteTaskQuerySchema,
    },
  );
