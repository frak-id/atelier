import type { Static } from "elysia";
import { t } from "elysia";

export const BaseImageIdSchema = t.Union([
  t.Literal("dev-base"),
  t.Literal("dev-node"),
  t.Literal("dev-rust"),
  t.Literal("dev-python"),
  t.Literal("dev-go"),
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
  "dev-node": {
    id: "dev-node",
    name: "Node.js Development",
    description: "Node.js + pnpm + Bun for JavaScript/TypeScript projects",
    volumeSize: 5,
    tools: ["code-server", "opencode", "node", "pnpm", "bun", "git"],
    volumeName: "image-dev-node",
    available: false,
  },
  "dev-rust": {
    id: "dev-rust",
    name: "Rust Development",
    description: "Rust toolchain with cargo and common tools",
    volumeSize: 6,
    tools: ["code-server", "opencode", "rustup", "cargo", "git"],
    volumeName: "image-dev-rust",
    available: false,
  },
  "dev-python": {
    id: "dev-python",
    name: "Python Development",
    description: "Python with pip, poetry, and virtual environments",
    volumeSize: 5,
    tools: ["code-server", "opencode", "python3", "pip", "poetry", "git"],
    volumeName: "image-dev-python",
    available: false,
  },
  "dev-go": {
    id: "dev-go",
    name: "Go Development",
    description: "Go toolchain with common tools",
    volumeSize: 5,
    tools: ["code-server", "opencode", "go", "git"],
    volumeName: "image-dev-go",
    available: false,
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
