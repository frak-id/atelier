/**
 * The image builder port + its backends. Mirrors `../../backend/index.ts`'s
 * `createSandboxBackend` selection pattern: the (live) image-builder config
 * chooses the concrete backend, and a kind that isn't implemented yet fails
 * fast at construction with a clear message rather than silently degrading.
 */
import { SandboxError } from "../../../shared/errors.ts";
import { imageBuilderConfig } from "../../../shared/lib/runtime-config.ts";
import type { ImageBuilderBackend } from "./builder.types.ts";
import { BuildkitImageBuilder } from "./buildkit.builder.ts";
import { DockerImageBuilder } from "./docker.builder.ts";

export type {
  ImageBuilderBackend,
  ImageBuildRequest,
  ImageBuildResult,
} from "./builder.types.ts";
export { BuildkitImageBuilder } from "./buildkit.builder.ts";
export { DockerImageBuilder } from "./docker.builder.ts";

/**
 * Select the image builder backend from `config.imageBuilder.kind`:
 *   - docker:   shells out to a Docker daemon (local/remote). Lowest
 *               friction; needs a daemon (a stock k3s node has none).
 *   - buildkit: the recommended in-cluster builder. With no
 *               `imageBuilder.endpoint` (the default) it runs BuildKit
 *               itself daemonless inside the one-shot build Job — no
 *               external daemon needed. With an endpoint set it dispatches
 *               to an existing buildkitd via a `buildctl` Job instead.
 * An unknown kind fails fast here (at construction/startup), never on a
 * user's first build.
 */
export function createImageBuilder(
  cfg = imageBuilderConfig(),
  kind = cfg.kind,
): ImageBuilderBackend {
  if (kind === "docker") {
    return new DockerImageBuilder({
      dockerHost: cfg.dockerHost || undefined,
    });
  }
  if (kind === "buildkit") {
    return new BuildkitImageBuilder({
      endpoint: cfg.endpoint || undefined,
      image: cfg.image || undefined,
      tls: cfg.tls,
    });
  }
  throw new SandboxError(
    `imageBuilder.kind="${kind}" is not recognized. Use docker or buildkit ` +
      "(or the ATELIER_IMAGE_BUILDER_KIND env var).",
    "IMAGE_BUILDER_NOT_IMPLEMENTED",
    500,
  );
}
