import { Elysia, t } from "elysia";
import {
  sandboxDestroyer,
  sandboxLifecycle,
  taskService,
  taskSpawner,
} from "../container.ts";
import {
  AddSessionsBodySchema,
  CreateTaskBodySchema,
  IdParamSchema,
  ReorderTaskBodySchema,
  ResetTaskQuerySchema,
  SpawnSessionsResponseSchema,
  TaskListResponseSchema,
  TaskSchema,
  UpdateTaskBodySchema,
} from "../schemas/index.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

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
    "/:id/sessions",
    async ({ params, body, set }) => {
      log.info(
        { taskId: params.id, templateIds: body.sessionTemplateIds },
        "Adding sessions to task",
      );

      taskSpawner.spawnSessionsInBackground(params.id, body.sessionTemplateIds);

      set.status = 202;
      return {
        status: "spawning" as const,
        taskId: params.id,
        requestedTemplates: body.sessionTemplateIds,
        message: `Spawning ${body.sessionTemplateIds.length} session(s) in background`,
      };
    },
    {
      params: IdParamSchema,
      body: AddSessionsBodySchema,
      response: SpawnSessionsResponseSchema,
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
    async ({ params, query }) => {
      const task = taskService.getByIdOrThrow(params.id);
      const sandboxAction = (query.sandboxAction ?? "detach") as
        | "detach"
        | "stop"
        | "destroy";

      log.info({ taskId: params.id, sandboxAction }, "Resetting task to draft");

      if (task.data.sandboxId) {
        if (sandboxAction === "stop") {
          await sandboxLifecycle.stop(task.data.sandboxId);
        } else if (sandboxAction === "destroy") {
          await sandboxDestroyer.destroy(task.data.sandboxId);
        }
        // "detach" = do nothing, sandbox keeps running
      }

      return taskService.resetToDraft(params.id);
    },
    {
      params: IdParamSchema,
      query: ResetTaskQuerySchema,
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
    ({ params, set }) => {
      log.info({ taskId: params.id }, "Deleting task");

      taskService.delete(params.id);
      set.status = 204;
      return null;
    },
    {
      params: IdParamSchema,
    },
  );
