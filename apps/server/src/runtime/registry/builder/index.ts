/**
 * The image builder port + its backends. Mirrors `../../backend/index.ts`'s
 * `createSandboxBackend` selection pattern: `config.imageBuilder.kind`
 * chooses the concrete backend, and a kind that isn't implemented yet fails
 * fast at construction with a clear message rather than silently degrading.
 */
import { SandboxError } from "../../../shared/errors.ts";
import { config } from "../../../shared/lib/config.ts";
import type { ImageBuilderBackend } from "./builder.types.ts";
import { DockerImageBuilder } from "./docker.builder.ts";

export type {
  ImageBuilderBackend,
  ImageBuildRequest,
  ImageBuildResult,
} from "./builder.types.ts";
export { DockerImageBuilder } from "./docker.builder.ts";

/**
 * Select the image builder backend from `config.imageBuilder.kind`. Only
 * `docker` is implemented today; `buildkit`/`kaniko` throw a clear
 * `SandboxError` at construction (never at first build) so a misconfigured
 * deployment fails at startup, not on a user's first image build.
 */
export function createImageBuilder(
  kind: (typeof config.imageBuilder)["kind"] = config.imageBuilder.kind,
): ImageBuilderBackend {
  if (kind === "docker") {
    return new DockerImageBuilder({
      dockerHost: config.imageBuilder.dockerHost || undefined,
    });
  }
  throw new SandboxError(
    `imageBuilder.kind="${kind}" is not yet implemented; "docker" is the ` +
      "only builder available today. Set imageBuilder.kind=docker (or the " +
      "ATELIER_IMAGE_BUILDER_KIND env var).",
    "IMAGE_BUILDER_NOT_IMPLEMENTED",
    500,
  );
}
