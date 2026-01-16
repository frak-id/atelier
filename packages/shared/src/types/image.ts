/**
 * Base image type definitions
 */

/** Available base image identifiers */
export type BaseImageId =
  | "dev-base"
  | "dev-node"
  | "dev-rust"
  | "dev-python"
  | "dev-go";

/** Base image definition */
export interface BaseImage {
  /** Unique image identifier */
  id: BaseImageId;
  /** Human-readable name */
  name: string;
  /** Description of what's included */
  description: string;
  /** Size in GB for LVM volume */
  volumeSize: number;
  /** List of tools included in the image */
  tools: string[];
  /** LVM volume name (derived from id) */
  volumeName: string;
  /** Whether this image is currently available */
  available: boolean;
}

/** Registry of all base images with their configurations */
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
    available: false, // Coming soon
  },
  "dev-rust": {
    id: "dev-rust",
    name: "Rust Development",
    description: "Rust toolchain with cargo and common tools",
    volumeSize: 6,
    tools: ["code-server", "opencode", "rustup", "cargo", "git"],
    volumeName: "image-dev-rust",
    available: false, // Coming soon
  },
  "dev-python": {
    id: "dev-python",
    name: "Python Development",
    description: "Python with pip, poetry, and virtual environments",
    volumeSize: 5,
    tools: ["code-server", "opencode", "python3", "pip", "poetry", "git"],
    volumeName: "image-dev-python",
    available: false, // Coming soon
  },
  "dev-go": {
    id: "dev-go",
    name: "Go Development",
    description: "Go toolchain with common tools",
    volumeSize: 5,
    tools: ["code-server", "opencode", "go", "git"],
    volumeName: "image-dev-go",
    available: false, // Coming soon
  },
};

/** Default base image to use when none specified */
export const DEFAULT_BASE_IMAGE: BaseImageId = "dev-base";

/** Get base image by ID, returns undefined if not found */
export function getBaseImage(id: BaseImageId): BaseImage | undefined {
  return BASE_IMAGES[id];
}

/** Get all available base images */
export function getAvailableImages(): BaseImage[] {
  return Object.values(BASE_IMAGES).filter((img) => img.available);
}

/** Get all base images (including unavailable) */
export function getAllImages(): BaseImage[] {
  return Object.values(BASE_IMAGES);
}
