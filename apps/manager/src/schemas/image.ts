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
