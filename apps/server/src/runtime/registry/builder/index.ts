/**
 * The image builder port + its backends. Mirrors `../../backend/index.ts`'s
 * `createSandboxBackend` selection pattern: `config.imageBuilder.kind`
 * chooses the concrete backend, and a kind that isn't implemented yet fails
 * fast at construction with a clear message rather than silently degrading.
 */
import { SandboxError } from "../../../shared/errors.ts";
import { config } from "../../../shared/lib/config.ts";
import type { ImageBuilderBackend } from "./builder.types.ts";
import { BuildkitImageBuilder } from "./buildkit.builder.ts";
import { DockerImageBuilder } from "./docker.builder.ts";
import { KanikoImageBuilder } from "./kaniko.builder.ts";

export type {
  ImageBuilderBackend,
  ImageBuildRequest,
  ImageBuildResult,
} from "./builder.types.ts";
export { BuildkitImageBuilder } from "./buildkit.builder.ts";
export { DockerImageBuilder } from "./docker.builder.ts";
export { KanikoImageBuilder } from "./kaniko.builder.ts";

/**
 * Select the image builder backend from `config.imageBuilder.kind`:
 *   - docker:   shells out to a Docker daemon (local/remote). Lowest
 *               friction; needs a daemon (a stock k3s node has none).
 *   - kaniko:   runs a kaniko Job in-cluster — no daemon at all.
 *   - buildkit: dispatches to an existing buildkitd via a buildctl Job.
 * An unknown kind fails fast here (at construction/startup), never on a
 * user's first build.
 */
export function createImageBuilder(
  kind: (typeof config.imageBuilder)["kind"] = config.imageBuilder.kind,
): ImageBuilderBackend {
  if (kind === "docker") {
    return new DockerImageBuilder({
      dockerHost: config.imageBuilder.dockerHost || undefined,
    });
  }
  if (kind === "kaniko") {
    return new KanikoImageBuilder({
      image: config.imageBuilder.image || undefined,
    });
  }
  if (kind === "buildkit") {
    return new BuildkitImageBuilder({
      endpoint: config.imageBuilder.endpoint || undefined,
      image: config.imageBuilder.image || undefined,
      tls: config.imageBuilder.tls,
    });
  }
  throw new SandboxError(
    `imageBuilder.kind="${kind}" is not recognized. Use docker, kaniko, or ` +
      "buildkit (or the ATELIER_IMAGE_BUILDER_KIND env var).",
    "IMAGE_BUILDER_NOT_IMPLEMENTED",
    500,
  );
}
