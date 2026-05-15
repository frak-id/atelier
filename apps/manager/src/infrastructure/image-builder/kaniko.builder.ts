import type { KubeResource } from "../kubernetes/index.ts";
import type { BuildContext, ImageBuilder } from "./types.ts";

const DEFAULT_KANIKO_IMAGE = "gcr.io/kaniko-project/executor:latest";

export type KanikoBuilderOptions = {
  /** Override the Kaniko executor image. */
  image?: string;
  /** Whether the destination/cache registry is HTTP (or self-signed TLS). */
  insecureRegistry?: boolean;
};

/**
 * Builds base images by spawning a K8s Job that runs the Kaniko executor.
 *
 * The build context is shipped via a ConfigMap. Because Kaniko reads from
 * the local filesystem, an init container materializes the ConfigMap into
 * an emptyDir at `/workspace` (preserving the original directory layout
 * via `configMapItems[].path`).
 */
export class KanikoBuilder implements ImageBuilder {
  readonly kind = "kaniko";

  constructor(private readonly options: KanikoBuilderOptions = {}) {}

  buildJob(ctx: BuildContext): KubeResource {
    const image = this.options.image || DEFAULT_KANIKO_IMAGE;
    const insecure = this.options.insecureRegistry ?? true;

    const args: string[] = [
      "--context=dir:///workspace",
      "--dockerfile=Dockerfile",
      `--destination=${ctx.destinationImage}`,
      "--cache=true",
      `--cache-repo=${ctx.cacheRepo}`,
      "--cache-copy-layers",
    ];

    if (insecure) {
      args.push("--insecure", "--insecure-pull");
    }

    for (const [key, value] of Object.entries(ctx.buildArgs ?? {})) {
      args.push(`--build-arg=${key}=${value}`);
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
            initContainers: [
              {
                name: "prepare-context",
                image: "busybox:1.37",
                command: ["sh", "-c", "cp -rL /config/* /workspace/"],
                volumeMounts: [
                  { name: "config", mountPath: "/config", readOnly: true },
                  { name: "workspace", mountPath: "/workspace" },
                ],
              },
            ],
            containers: [
              {
                name: "kaniko",
                image,
                args,
                volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
              },
            ],
            volumes: [
              {
                name: "config",
                configMap: {
                  name: ctx.configMapName,
                  items: ctx.configMapItems,
                },
              },
              { name: "workspace", emptyDir: {} },
            ],
          },
        },
      },
    };
  }
}
