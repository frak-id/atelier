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

/**
 * Integration metadata attached to a Task, used to:
 *   - identify the conversation that spawned/owns this task (`source` +
 *     `externalId` — same shape as `Sandbox.origin`),
 *   - reply back into that conversation (`slack` / `github` blobs hold the
 *     adapter-specific reply state),
 *   - resume the right OpenCode session on follow-ups (`sessionId`).
 *
 * For pure provenance / display, prefer `Sandbox.origin` — it carries the
 * same `source` + `externalId` + `externalUrl` triplet without the reply
 * state, and is set on every sandbox regardless of how it was spawned.
 */
export const TaskIntegrationMetadataSchema = t.Object({
  /** Source system (e.g. `slack`, `github`). Mirrors `SandboxOrigin.source`. */
  source: t.String(),
  /**
   * Stable identifier from the source system used to look this task up on
   * follow-up events. Mirrors `SandboxOrigin.externalId`.
   * Slack: `${channel}:${threadTs}` — GitHub: `${owner}/${repo}:${prNumber}`.
   */
  externalId: t.String(),
  /** Optional deep-link back to the origin (PR, slack thread, etc). */
  externalUrl: t.Optional(t.String()),
  /** Current OpenCode session id, used to continue the same session on replies. */
  sessionId: t.Optional(t.String()),
  slack: t.Optional(
    t.Object({
      channel: t.String(),
      ts: t.String(),
      threadTs: t.String(),
      teamId: t.Optional(t.String()),
      triggeredBy: t.Optional(t.String()),
    }),
  ),
  github: t.Optional(
    t.Object({
      owner: t.String(),
      repo: t.String(),
      prNumber: t.Number(),
      commentId: t.Optional(t.Number()),
      triggeredBy: t.Optional(t.String()),
    }),
  ),
});
export type TaskIntegrationMetadata = Static<
  typeof TaskIntegrationMetadataSchema
>;

export const TaskCreatorSchema = t.Object({
  username: t.String(),
  email: t.String(),
  avatarUrl: t.String(),
});
export type TaskCreator = Static<typeof TaskCreatorSchema>;

export const TaskDataSchema = t.Object({
  description: t.String(),
  workflowId: t.Optional(t.String()),
  variantIndex: t.Optional(t.Number()),
  sandboxId: t.Optional(t.String()),
  sessions: t.Optional(t.Array(TaskSessionSchema)),
  createdBy: t.Optional(TaskCreatorSchema),
  startedAt: t.Optional(t.String()),
  completedAt: t.Optional(t.String()),
  order: t.Number({ default: 0 }),
  baseBranch: t.Optional(t.String()),
  branchName: t.Optional(t.String()),
  targetRepoIndices: t.Optional(t.Array(t.Number())),
  integration: t.Optional(TaskIntegrationMetadataSchema),
});
export type TaskData = Static<typeof TaskDataSchema>;

export const TaskSchema = t.Object({
  id: t.String(),
  orgId: t.Optional(t.String()),
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
  title: t.Optional(t.String({ maxLength: 200 })),
  description: t.String({ minLength: 1 }),
  workflowId: t.Optional(t.String()),
  variantIndex: t.Optional(t.Number()),
  baseBranch: t.Optional(t.String()),
  targetRepoIndices: t.Optional(t.Array(t.Number())),
  integration: t.Optional(TaskIntegrationMetadataSchema),
});
export type CreateTaskBody = Static<typeof CreateTaskBodySchema>;

export const UpdateTaskBodySchema = t.Object({
  title: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
  description: t.Optional(t.String({ minLength: 1 })),
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

export const SpawnSessionResponseSchema = t.Object({
  status: t.Literal("spawning"),
  taskId: t.String(),
  sessionTemplateId: t.String(),
  message: t.String(),
});
export type SpawnSessionResponse = Static<typeof SpawnSessionResponseSchema>;

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
