import type { KubeResource } from "../kubernetes/index.ts";
import type { BuildContext, ImageBuilder } from "./types.ts";

const DEFAULT_BUILDKIT_IMAGE = "moby/buildkit:latest";

export type BuildkitBuilderOptions = {
  /** gRPC address of the BuildKit daemon (e.g. tcp://buildkitd.ns.svc:1234). */
  endpoint: string;
  /** Override the buildctl client image (`buildctl` binary). */
  image?: string;
  /** Treat destination/cache registry as HTTP/insecure-TLS. */
  insecureRegistry?: boolean;
};

/**
 * Builds base images by dispatching the work to an EXISTING BuildKit
 * daemon over its gRPC endpoint. The spawned Job only runs a `buildctl`
 * client which uploads the context and streams progress — the daemon
 * does the actual build.
 *
 * BuildKit can read the context directly from a mounted directory, so
 * (unlike Kaniko) we skip the init-container copy: the ConfigMap is
 * mounted read-only at /context with `items[].path` restoring layout.
 */
export class BuildkitBuilder implements ImageBuilder {
  readonly kind = "buildkit";

  constructor(private readonly options: BuildkitBuilderOptions) {
    if (!options.endpoint) {
      throw new Error(
        "BuildkitBuilder requires `endpoint` (e.g. tcp://buildkitd.ns.svc:1234)",
      );
    }
  }

  buildJob(ctx: BuildContext): KubeResource {
    const image = this.options.image || DEFAULT_BUILDKIT_IMAGE;
    const insecure = this.options.insecureRegistry ?? true;

    const outputOpts = [
      "type=image",
      `name=${ctx.destinationImage}`,
      "push=true",
      ...(insecure ? ["registry.insecure=true"] : []),
    ].join(",");

    const cacheCommon = [`ref=${ctx.cacheRepo}`];
    if (insecure) cacheCommon.push("registry.insecure=true");
    const exportCache = ["type=registry", "mode=max", ...cacheCommon].join(",");
    const importCache = ["type=registry", ...cacheCommon].join(",");

    const args: string[] = [
      "--addr",
      this.options.endpoint,
      "build",
      "--frontend",
      "dockerfile.v0",
      "--local",
      "context=/context",
      "--local",
      "dockerfile=/context",
      "--output",
      outputOpts,
      "--export-cache",
      exportCache,
      "--import-cache",
      importCache,
    ];

    for (const [key, value] of Object.entries(ctx.buildArgs ?? {})) {
      args.push("--opt", `build-arg:${key}=${value}`);
    }

    return {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: {
        name: ctx.jobName,
        namespace: ctx.namespace,
        labels: ctx.labels,
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 3600,
        template: {
          metadata: { labels: ctx.labels },
          spec: {
            restartPolicy: "Never",
            containers: [
              {
                name: "buildctl",
                image,
                command: ["buildctl"],
                args,
                volumeMounts: [
                  { name: "context", mountPath: "/context", readOnly: true },
                ],
              },
            ],
            volumes: [
              {
                name: "context",
                configMap: {
                  name: ctx.configMapName,
                  items: ctx.configMapItems,
                },
              },
            ],
          },
        },
      },
    };
  }
}
