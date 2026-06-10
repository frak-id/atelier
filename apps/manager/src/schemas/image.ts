import type { Static } from "elysia";
import { t } from "elysia";

export const BaseImageSchema = t.Object({
  id: t.String(),
  name: t.String(),
  description: t.String(),
  volumeSize: t.Number(),
  tools: t.Array(t.String()),
  base: t.Union([t.String(), t.Null()]),
  official: t.Optional(t.Boolean()),
  available: t.Boolean(),
});
export type BaseImage = Static<typeof BaseImageSchema>;

export const ImageListQuerySchema = t.Object({
  all: t.Optional(t.BooleanString()),
});
export type ImageListQuery = Static<typeof ImageListQuerySchema>;

export const ImageListResponseSchema = t.Array(BaseImageSchema);
export type ImageListResponse = Static<typeof ImageListResponseSchema>;

export const ImageBuildStatusValues = [
  "idle",
  "building",
  "succeeded",
  "failed",
] as const;
export type ImageBuildStatus = (typeof ImageBuildStatusValues)[number];

export const ImageBuildSchema = t.Object({
  imageId: t.String(),
  status: t.Union([
    t.Literal("idle"),
    t.Literal("building"),
    t.Literal("succeeded"),
    t.Literal("failed"),
  ]),
  jobName: t.Optional(t.String()),
  startedAt: t.Optional(t.Number()),
  finishedAt: t.Optional(t.Number()),
  error: t.Optional(t.String()),
});
export type ImageBuild = Static<typeof ImageBuildSchema>;

export const ImageBuildTriggerResponseSchema = t.Object({
  imageId: t.String(),
  jobName: t.String(),
  status: t.Literal("building"),
  message: t.String(),
});
export type ImageBuildTriggerResponse = Static<
  typeof ImageBuildTriggerResponseSchema
>;

export const ImageBuildListResponseSchema = t.Array(ImageBuildSchema);
export type ImageBuildListResponse = Static<
  typeof ImageBuildListResponseSchema
>;

export const RebuildAllImageSchema = t.Object({
  imageId: t.String(),
  status: t.Union([
    t.Literal("pending"),
    t.Literal("building"),
    t.Literal("succeeded"),
    t.Literal("failed"),
    t.Literal("skipped"),
  ]),
  error: t.Optional(t.String()),
});
export type RebuildAllImage = Static<typeof RebuildAllImageSchema>;

export const RebuildAllStatusSchema = t.Object({
  active: t.Boolean(),
  startedAt: t.Number(),
  finishedAt: t.Optional(t.Number()),
  images: t.Array(RebuildAllImageSchema),
});
export type RebuildAllStatus = Static<typeof RebuildAllStatusSchema>;

export const RebuildAllTriggerResponseSchema = t.Object({
  order: t.Array(t.Array(t.String())),
  message: t.String(),
});
export type RebuildAllTriggerResponse = Static<
  typeof RebuildAllTriggerResponseSchema
>;
