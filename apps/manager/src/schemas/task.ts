import type { Static } from "elysia";
import { t } from "elysia";

export const TaskStatusValues = ["draft", "active", "done"] as const;

export type TaskStatus = (typeof TaskStatusValues)[number];

export const TaskSessionSchema = t.Object({
  id: t.String(),
  templateId: t.String(),
  order: t.Number(),
  startedAt: t.Optional(t.String()),
});
export type TaskSession = Static<typeof TaskSessionSchema>;

export const TaskDataSchema = t.Object({
  description: t.String(),
  context: t.Optional(t.String()),
  workflowId: t.Optional(t.String()),
  variantIndex: t.Optional(t.Number()),
  sandboxId: t.Optional(t.String()),
  sessions: t.Optional(t.Array(TaskSessionSchema)),
  createdBy: t.Optional(t.String()),
  startedAt: t.Optional(t.String()),
  completedAt: t.Optional(t.String()),
  order: t.Number({ default: 0 }),
  baseBranch: t.Optional(t.String()),
  branchName: t.Optional(t.String()),
  targetRepoIndices: t.Optional(t.Array(t.Number())),
});
export type TaskData = Static<typeof TaskDataSchema>;

export const TaskSchema = t.Object({
  id: t.String(),
  workspaceId: t.String(),
  title: t.String(),
  status: t.String(),
  data: TaskDataSchema,
  createdAt: t.String(),
  updatedAt: t.String(),
});
export type Task = Static<typeof TaskSchema>;

export const CreateTaskBodySchema = t.Object({
  workspaceId: t.String({ minLength: 1 }),
  title: t.String({ minLength: 1, maxLength: 200 }),
  description: t.String({ minLength: 1 }),
  context: t.Optional(t.String()),
  workflowId: t.Optional(t.String()),
  variantIndex: t.Optional(t.Number()),
  baseBranch: t.Optional(t.String()),
  targetRepoIndices: t.Optional(t.Array(t.Number())),
});
export type CreateTaskBody = Static<typeof CreateTaskBodySchema>;

export const UpdateTaskBodySchema = t.Object({
  title: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
  description: t.Optional(t.String({ minLength: 1 })),
  context: t.Optional(t.String()),
  workflowId: t.Optional(t.String()),
  variantIndex: t.Optional(t.Number()),
});
export type UpdateTaskBody = Static<typeof UpdateTaskBodySchema>;

export const ReorderTaskBodySchema = t.Object({
  order: t.Number({ minimum: 0 }),
});
export type ReorderTaskBody = Static<typeof ReorderTaskBodySchema>;

export const AddSessionBodySchema = t.Object({
  sessionTemplateId: t.String({ minLength: 1 }),
});
export type AddSessionBody = Static<typeof AddSessionBodySchema>;

export const AddSessionsBodySchema = t.Object({
  sessionTemplateIds: t.Array(t.String({ minLength: 1 }), { minItems: 1 }),
});
export type AddSessionsBody = Static<typeof AddSessionsBodySchema>;

export const SpawnSessionsResponseSchema = t.Object({
  status: t.Literal("spawning"),
  taskId: t.String(),
  requestedTemplates: t.Array(t.String()),
  message: t.String(),
});
export type SpawnSessionsResponse = Static<typeof SpawnSessionsResponseSchema>;

export const SandboxActionValues = ["detach", "stop", "destroy"] as const;
export type SandboxAction = (typeof SandboxActionValues)[number];

export const ResetTaskQuerySchema = t.Object({
  sandboxAction: t.Optional(t.String()),
});
export type ResetTaskQuery = Static<typeof ResetTaskQuerySchema>;

export const DeleteTaskQuerySchema = t.Object({
  sandboxAction: t.Optional(t.String()),
});
export type DeleteTaskQuery = Static<typeof DeleteTaskQuerySchema>;

export const TaskListResponseSchema = t.Array(TaskSchema);
export type TaskListResponse = Static<typeof TaskListResponseSchema>;
