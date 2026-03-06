import { Elysia, t } from "elysia";
import {
  sandboxDestroyer,
  sandboxLifecycle,
  systemAiService,
  taskService,
  taskSpawner,
} from "../container.ts";
import {
  AddSessionBodySchema,
  CreateTaskBodySchema,
  DeleteTaskQuerySchema,
  IdParamSchema,
  ReorderTaskBodySchema,
  ResetTaskQuerySchema,
  SpawnSessionResponseSchema,
  TaskListResponseSchema,
  TaskSchema,
  UpdateTaskBodySchema,
} from "../schemas/index.ts";
import type { AuthUser } from "../shared/lib/auth.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("task-routes");

function getUser(store: { user?: AuthUser }): AuthUser {
  if (!store.user) throw new Error("User not authenticated");
  return store.user;
}

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
    ({ body, set, store }) => {
      const user = getUser(store as { user?: AuthUser });
      const title =
        body.title?.trim() || systemAiService.fallbackTitle(body.description);

      log.info({ title, workspaceId: body.workspaceId }, "Creating task");

      const task = taskService.create({
        ...body,
        title,
        createdBy: {
          username: user.username,
          email: user.email,
          avatarUrl: user.avatarUrl,
        },
      });

      if (!body.title?.trim()) {
        systemAiService.generateTitleInBackground(
          body.description,
          (generatedTitle) => {
            taskService.updateTitle(task.id, generatedTitle);
            taskSpawner
              .updateSessionTitles(task.id, generatedTitle)
              .catch(() => {});
          },
        );
      }

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
        { taskId: params.id, templateId: body.sessionTemplateId },
        "Adding session to task",
      );

      taskSpawner.addSessionInBackground(params.id, body.sessionTemplateId);

      set.status = 202;
      return {
        status: "spawning" as const,
        taskId: params.id,
        sessionTemplateId: body.sessionTemplateId,
        message: "Spawning session in background",
      };
    },
    {
      params: IdParamSchema,
      body: AddSessionBodySchema,
      response: SpawnSessionResponseSchema,
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
    async ({ params, query, set }) => {
      const task = taskService.getByIdOrThrow(params.id);
      const sandboxAction = (query.sandboxAction ?? "detach") as
        | "detach"
        | "stop"
        | "destroy";

      log.info({ taskId: params.id, sandboxAction }, "Deleting task");

      if (task.data.sandboxId) {
        try {
          if (sandboxAction === "stop") {
            await sandboxLifecycle.stop(task.data.sandboxId);
          } else if (sandboxAction === "destroy") {
            await sandboxDestroyer.destroy(task.data.sandboxId);
          }
        } catch (error) {
          log.warn(
            { taskId: params.id, sandboxId: task.data.sandboxId, error },
            "Sandbox cleanup failed during task deletion, continuing",
          );
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
