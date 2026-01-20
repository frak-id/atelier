import type { Static } from "elysia";
import { t } from "elysia";

export const BaseImageIdSchema = t.Union([
  t.Literal("dev-base"),
  t.Literal("dev-cloud"),
]);
export type BaseImageId = Static<typeof BaseImageIdSchema>;

export const BaseImageSchema = t.Object({
  id: BaseImageIdSchema,
  name: t.String(),
  description: t.String(),
  volumeSize: t.Number(),
  tools: t.Array(t.String()),
  volumeName: t.String(),
  available: t.Boolean(),
});
export type BaseImage = Static<typeof BaseImageSchema>;

export const ImageListQuerySchema = t.Object({
  all: t.Optional(t.BooleanString()),
});
export type ImageListQuery = Static<typeof ImageListQuerySchema>;

export const ImageListResponseSchema = t.Array(BaseImageSchema);
export type ImageListResponse = Static<typeof ImageListResponseSchema>;

export const BASE_IMAGES: Record<BaseImageId, BaseImage> = {
  "dev-base": {
    id: "dev-base",
    name: "Base Development",
    description:
      "Minimal dev environment with code-server, OpenCode, Bun, and Git",
    volumeSize: 5,
    tools: [
      "code-server",
      "opencode",
      "bun",
      "node",
      "git",
      "curl",
      "ssh",
      "htop",
    ],
    volumeName: "image-dev-base",
    available: true,
  },
  "dev-cloud": {
    id: "dev-cloud",
    name: "Cloud Development",
    description:
      "Extended dev environment with AWS CLI, Google Cloud SDK, kubectl, and Pulumi for cloud deployments",
    volumeSize: 7,
    tools: [
      "code-server",
      "opencode",
      "bun",
      "node",
      "git",
      "aws",
      "gcloud",
      "kubectl",
      "pulumi",
    ],
    volumeName: "image-dev-cloud",
    available: true,
  },
};

export const DEFAULT_BASE_IMAGE: BaseImageId = "dev-base";

export function getBaseImage(id: BaseImageId): BaseImage | undefined {
  return BASE_IMAGES[id];
}

export function getAvailableImages(): BaseImage[] {
  return Object.values(BASE_IMAGES).filter((img) => img.available);
}

export function getAllImages(): BaseImage[] {
  return Object.values(BASE_IMAGES);
}
