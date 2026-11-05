/**
 * The image builder port + its two backends. The (live) image-builder config
 * chooses the concrete backend; a misconfigured kind fails fast at
 * construction with a clear message rather than silently degrading.
 */
import { SandboxError } from "../../../shared/errors.ts";
import { imageBuilderConfig } from "../../../shared/lib/runtime-config.ts";
import type { ImageBuilderBackend } from "./builder.types.ts";
import { BuildkitImageBuilder } from "./buildkit.builder.ts";
import { DockerImageBuilder } from "./docker.builder.ts";

export type { ImageBuilderBackend } from "./builder.types.ts";

/**
 * Select the image builder backend from `config.imageBuilder.kind`:
 *   - docker:   shells out to a Docker daemon (local mode: builds the seed
 *               images straight into the host daemon, no registry).
 *   - buildkit: the in-cluster builder (production). Dispatches to the
 *               external buildkitd at `imageBuilder.endpoint` via a
 *               `buildctl` Job; the endpoint is required.
 * A misconfiguration fails fast here, never on a user's first build.
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
    if (!cfg.endpoint) {
      throw new SandboxError(
        'imageBuilder.kind="buildkit" needs imageBuilder.endpoint (the ' +
          "buildkitd address, e.g. tcp://buildkitd.buildkit.svc:1234).",
        "IMAGE_BUILDER_MISCONFIGURED",
        500,
      );
    }
    return new BuildkitImageBuilder({
      endpoint: cfg.endpoint,
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
