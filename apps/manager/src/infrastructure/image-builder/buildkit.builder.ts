import type { KubeResource } from "../kubernetes/index.ts";
import type { BuildContext, ImageBuilder } from "./types.ts";

const DEFAULT_BUILDKIT_IMAGE = "moby/buildkit:latest";
const TLS_MOUNT_PATH = "/etc/buildkit/tls";

export type BuildkitBuilderTlsOptions = {
  /**
   * K8s Secret name (in the build Job's namespace) holding `ca.crt`,
   * `tls.crt`, `tls.key`. Empty/undefined disables mTLS.
   */
  secretName?: string;
  /** Override the SNI/hostname used by buildctl (`--tlsservername`). */
  serverName?: string;
};

export type BuildkitBuilderOptions = {
  /** gRPC address of the BuildKit daemon (e.g. tcp://buildkitd.ns.svc:1234). */
  endpoint: string;
  /** Override the buildctl client image (`buildctl` binary). */
  image?: string;
  /** Treat destination/cache registry as HTTP/insecure-TLS. */
  insecureRegistry?: boolean;
  /** Optional mTLS settings for the connection to buildkitd. */
  tls?: BuildkitBuilderTlsOptions;
};

/**
 * Builds base images by dispatching the work to an EXISTING BuildKit
 * daemon over its gRPC endpoint. The spawned Job only runs a `buildctl`
 * client which uploads the context and streams progress — the daemon
 * does the actual build.
 *
 * An init container materializes the ConfigMap context into an emptyDir,
 * dereferencing the `..data/...` symlinks that ConfigMap volumes use
 * (buildctl's `--local` can fail to descend into nested subdirs otherwise).
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
    const tlsSecretName = this.options.tls?.secretName?.trim();
    const tlsServerName = this.options.tls?.serverName?.trim();

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

    /* mTLS flags must precede `build` (they're top-level buildctl flags). */
    const tlsFlags: string[] = [];
    if (tlsSecretName) {
      tlsFlags.push(
        "--tlscacert",
        `${TLS_MOUNT_PATH}/ca.crt`,
        "--tlscert",
        `${TLS_MOUNT_PATH}/tls.crt`,
        "--tlskey",
        `${TLS_MOUNT_PATH}/tls.key`,
      );
      if (tlsServerName) {
        tlsFlags.push("--tlsservername", tlsServerName);
      }
    }

    const args: string[] = [
      "--addr",
      this.options.endpoint,
      ...tlsFlags,
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
      /* Disable SBOM/provenance attestations. They wrap the image in an OCI
       * image-index that some registries (notably Zot <2.2) reject with 415.
       * Matches Kaniko behaviour (no attestations) so the two builders produce
       * interchangeable artifacts. */
      "--opt",
      "attest:provenance=disabled",
      "--opt",
      "attest:sbom=disabled",
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
            initContainers: [
              {
                name: "prepare-context",
                image: "busybox:1.37",
                command: ["sh", "-c", "cp -rL /config/. /context/"],
                volumeMounts: [
                  { name: "config", mountPath: "/config", readOnly: true },
                  { name: "context", mountPath: "/context" },
                ],
              },
            ],
            containers: [
              {
                name: "buildctl",
                image,
                command: ["buildctl"],
                args,
                volumeMounts: [
                  { name: "context", mountPath: "/context", readOnly: true },
                  ...(tlsSecretName
                    ? [
                        {
                          name: "buildkit-tls",
                          mountPath: TLS_MOUNT_PATH,
                          readOnly: true,
                        },
                      ]
                    : []),
                ],
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
              { name: "context", emptyDir: {} },
              ...(tlsSecretName
                ? [
                    {
                      name: "buildkit-tls",
                      secret: { secretName: tlsSecretName },
                    },
                  ]
                : []),
            ],
          },
        },
      },
    };
  }
}
