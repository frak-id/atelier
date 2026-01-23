import type { Static } from "elysia";
import { t } from "elysia";

export const TaskStatusValues = [
  "draft",
  "queue",
  "in_progress",
  "pending_review",
  "completed",
] as const;

export type TaskStatus = (typeof TaskStatusValues)[number];

export const TaskDataSchema = t.Object({
  description: t.String(),
  context: t.Optional(t.String()),
  sandboxId: t.Optional(t.String()),
  opencodeSessionId: t.Optional(t.String()),
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
  baseBranch: t.Optional(t.String()),
  targetRepoIndices: t.Optional(t.Array(t.Number())),
});
export type CreateTaskBody = Static<typeof CreateTaskBodySchema>;

export const UpdateTaskBodySchema = t.Object({
  title: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
  description: t.Optional(t.String({ minLength: 1 })),
  context: t.Optional(t.String()),
});
export type UpdateTaskBody = Static<typeof UpdateTaskBodySchema>;

export const ReorderTaskBodySchema = t.Object({
  order: t.Number({ minimum: 0 }),
});
export type ReorderTaskBody = Static<typeof ReorderTaskBodySchema>;

export const DeleteTaskQuerySchema = t.Object({
  keepSandbox: t.Optional(t.String()),
});
export type DeleteTaskQuery = Static<typeof DeleteTaskQuerySchema>;

export const TaskListResponseSchema = t.Array(TaskSchema);
export type TaskListResponse = Static<typeof TaskListResponseSchema>;
