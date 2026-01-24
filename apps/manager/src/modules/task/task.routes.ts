import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { Elysia, t } from "elysia";
import {
  sandboxService,
  sessionMonitor,
  taskService,
  taskSpawner,
} from "../../container.ts";
import {
  AddSessionsBodySchema,
  CreateTaskBodySchema,
  DeleteTaskQuerySchema,
  IdParamSchema,
  ReorderTaskBodySchema,
  type SessionInteraction,
  type TaskInteractionState,
  TaskInteractionStateSchema,
  TaskListResponseSchema,
  TaskSchema,
  UpdateTaskBodySchema,
} from "../../schemas/index.ts";
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
      return taskService.getByIdOrThrow(params.id);
    },
    {
      params: IdParamSchema,
      body: AddSessionsBodySchema,
      response: TaskSchema,
    },
  )
  .post(
    "/:id/complete",
    ({ params }) => {
      log.info({ taskId: params.id }, "Completing task");
      sessionMonitor.stopMonitoringTask(params.id);
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
  .get(
    "/:id/interaction-state",
    async ({ params }): Promise<TaskInteractionState> => {
      const task = taskService.getByIdOrThrow(params.id);

      if (task.status !== "active" || !task.data.sandboxId) {
        return {
          taskId: task.id,
          available: false,
          needsAttention: false,
          sessions: [],
        };
      }

      const sandbox = sandboxService.getById(task.data.sandboxId);
      if (!sandbox?.runtime?.ipAddress) {
        return {
          taskId: task.id,
          available: false,
          needsAttention: false,
          sessions: [],
        };
      }

      try {
        const client = createOpencodeClient({
          baseUrl: `http://${sandbox.runtime.ipAddress}:3000`,
        });

        const [sessionStatusResult, permissionsResult, questionsResult] =
          await Promise.all([
            client.session.status(),
            client.permission.list(),
            client.question.list(),
          ]);

        const sessionStatuses = sessionStatusResult.data ?? {};
        const allPermissions = permissionsResult.data ?? [];
        const allQuestions = questionsResult.data ?? [];

        const sessions: SessionInteraction[] = [];

        for (const taskSession of task.data.sessions ?? []) {
          const statusInfo = sessionStatuses[taskSession.id];
          let status: SessionInteraction["status"] = "unknown";

          if (statusInfo) {
            if (statusInfo.type === "idle") {
              status = "idle";
            } else if (statusInfo.type === "busy") {
              status = "busy";
            } else if (statusInfo.type === "retry") {
              status = "waiting";
            }
          }

          const pendingPermissions = allPermissions
            .filter((p) => p.sessionID === taskSession.id)
            .map((p) => ({
              id: p.id,
              sessionId: p.sessionID,
              permission: p.permission,
              patterns: p.patterns ?? [],
              metadata: p.metadata as Record<string, unknown> | undefined,
            }));

          const pendingQuestions = allQuestions
            .filter((q) => q.sessionID === taskSession.id)
            .map((q) => ({
              id: q.id,
              sessionId: q.sessionID,
              question: q.questions?.[0]?.question ?? "",
              options: q.questions?.[0]?.options?.map((o) => o.label) ?? [],
            }));

          sessions.push({
            sessionId: taskSession.id,
            status,
            pendingPermissions,
            pendingQuestions,
          });
        }

        const needsAttention = sessions.some(
          (s) =>
            s.pendingPermissions.length > 0 || s.pendingQuestions.length > 0,
        );

        return {
          taskId: task.id,
          available: true,
          needsAttention,
          sessions,
        };
      } catch (error) {
        log.warn(
          { taskId: task.id, error: String(error) },
          "Failed to fetch interaction state",
        );
        return {
          taskId: task.id,
          available: false,
          needsAttention: false,
          sessions: [],
        };
      }
    },
    {
      params: IdParamSchema,
      response: TaskInteractionStateSchema,
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
