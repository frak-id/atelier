import type { ImageBuilderConfig } from "@frak/atelier-shared/config";
import { BuildkitBuilder } from "./buildkit.builder.ts";
import { KanikoBuilder } from "./kaniko.builder.ts";
import type { ImageBuilder } from "./types.ts";

export type { BuildContext, ImageBuilder } from "./types.ts";
export { BuildkitBuilder } from "./buildkit.builder.ts";
export { KanikoBuilder } from "./kaniko.builder.ts";

/**
 * Pick the configured image-builder strategy.
 *
 * Throws when `kind: "buildkit"` is selected without an `endpoint` — that
 * case is unrecoverable at runtime and surfacing it at boot is friendlier
 * than failing the first build hours later.
 */
export function createImageBuilder(config: ImageBuilderConfig): ImageBuilder {
  switch (config.kind) {
    case "kaniko":
      return new KanikoBuilder({
        image: config.image || undefined,
        insecureRegistry: config.insecureRegistry,
      });
    case "buildkit":
      if (!config.endpoint) {
        throw new Error(
          "imageBuilder.kind=buildkit requires imageBuilder.endpoint " +
            "(e.g. tcp://buildkitd.buildkit.svc:1234)",
        );
      }
      return new BuildkitBuilder({
        endpoint: config.endpoint,
        image: config.image || undefined,
        insecureRegistry: config.insecureRegistry,
        tls: config.tls?.secretName
          ? {
              secretName: config.tls.secretName,
              serverName: config.tls.serverName || undefined,
            }
          : undefined,
      });
    default: {
      const _exhaustive: never = config.kind;
      throw new Error(`Unknown imageBuilder.kind: ${String(_exhaustive)}`);
    }
  }
}
