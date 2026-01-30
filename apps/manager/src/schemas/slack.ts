import type { Static } from "elysia";
import { t } from "elysia";

export const SlackThreadStatusValues = [
  "pending",
  "spawning",
  "active",
  "ended",
  "error",
] as const;

export type SlackThreadStatus = (typeof SlackThreadStatusValues)[number];

export const SlackThreadDataSchema = t.Object({
  responses: t.Optional(t.Array(t.String())),
  error: t.Optional(t.String()),
});
export type SlackThreadData = Static<typeof SlackThreadDataSchema>;

export const SlackThreadSchema = t.Object({
  id: t.String(),
  workspaceId: t.String(),
  sandboxId: t.Optional(t.String()),
  sessionId: t.Optional(t.String()),
  channelId: t.String(),
  threadTs: t.String(),
  userId: t.String(),
  userName: t.Optional(t.String()),
  initialMessage: t.String(),
  branchName: t.Optional(t.String()),
  status: t.String(),
  data: SlackThreadDataSchema,
  createdAt: t.String(),
  updatedAt: t.String(),
});
export type SlackThread = Static<typeof SlackThreadSchema>;

export const SlackConfigSchema = t.Object({
  botToken: t.String(),
  appToken: t.String(),
  signingSecret: t.String(),
});
export type SlackConfig = Static<typeof SlackConfigSchema>;

export const SlackStatusSchema = t.Object({
  connected: t.Boolean(),
  activeThreads: t.Number(),
});
export type SlackStatus = Static<typeof SlackStatusSchema>;

export const SlackThreadListResponseSchema = t.Array(SlackThreadSchema);
export type SlackThreadListResponse = Static<
  typeof SlackThreadListResponseSchema
>;
