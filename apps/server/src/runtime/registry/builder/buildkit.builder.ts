/**
 * BuildKit implementation of `ImageBuilderBackend` — dispatches the build to
 * an EXISTING `buildkitd` daemon (`config.imageBuilder.endpoint`) via a tiny
 * one-shot `buildctl` client Job (see `./k8s-build-job.ts`). Use this when the
 * cluster already hosts a shared, rootless buildkitd Pod you want to reuse
 * (the multi-tenant-friendly answer the docker backend's security note points
 * at); kaniko is the choice when you'd rather not run a daemon at all.
 *
 * The client container runs `buildctl build` against the unpacked workspace,
 * pushes to `req.tag`, writes build metadata to a temp file, then greps the
 * pushed digest out of it into `/dev/termination-log` for the shared runner.
 * Optional mTLS to the daemon is mounted from `config.imageBuilder.tls`.
 */

import { SandboxError } from "../../../shared/errors.ts";
import { config } from "../../../shared/lib/config.ts";
import type {
  ImageBuilderBackend,
  ImageBuildRequest,
  ImageBuildResult,
} from "./builder.types.ts";
import {
  jobResourceName,
  runKubeBuildJob,
  WORKSPACE_DIR,
} from "./k8s-build-job.ts";

const DEFAULT_BUILDKIT_IMAGE = "moby/buildkit:latest";
const CERTS_MOUNT = "/certs";

export interface BuildkitImageBuilderOptions {
  /** buildkitd address, e.g. `tcp://buildkitd.buildkit.svc:1234`. Required. */
  endpoint?: string;
  /** `buildctl` client image override (`config.imageBuilder.image`). */
  image?: string;
  /** mTLS to the daemon (`config.imageBuilder.tls`). */
  tls?: { secretName?: string; serverName?: string };
}

export class BuildkitImageBuilder implements ImageBuilderBackend {
  private readonly endpoint: string;
  private readonly image: string;
  private readonly tls: { secretName: string; serverName: string };

  constructor(options: BuildkitImageBuilderOptions = {}) {
    if (!options.endpoint) {
      throw new SandboxError(
        'imageBuilder.kind="buildkit" requires imageBuilder.endpoint (the ' +
          "buildkitd address, e.g. tcp://buildkitd.buildkit.svc:1234). Set " +
          "it via ATELIER_IMAGE_BUILDER_ENDPOINT.",
        "IMAGE_BUILDER_MISCONFIGURED",
        500,
      );
    }
    this.endpoint = options.endpoint;
    this.image = options.image || DEFAULT_BUILDKIT_IMAGE;
    this.tls = {
      secretName: options.tls?.secretName ?? "",
      serverName: options.tls?.serverName ?? "",
    };
  }

  async build(
    req: ImageBuildRequest,
    onLog: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<ImageBuildResult> {
    const args = buildctlArgs(req, this.endpoint, this.tls);
    // buildctl writes metadata to a file; pin the MANIFEST digest
    // (`containerimage.digest`) into the termination log the shared runner
    // reads back. NOT the first sha256 in the file — that's
    // `containerimage.config.digest`, and pinning the config blob makes
    // containerd reject the pull ("unexpected media type
    // application/vnd.oci.image.config.v1+json"). The key match tolerates an
    // optional space after the colon so it works on compact or pretty JSON.
    const script =
      `set -e; buildctl ${args.join(" ")}; ` +
      'grep -o \'"containerimage\\.digest": *"sha256:[0-9a-f]\\{64\\}"\' ' +
      "/tmp/atelier-md.json | grep -o 'sha256:[0-9a-f]\\{64\\}' " +
      "> /dev/termination-log";

    const useTls = this.tls.secretName.length > 0;
    return runKubeBuildJob(
      {
        name: jobResourceName(req.tag),
        contextDir: req.contextDir,
        dockerfile: req.dockerfile,
        container: {
          image: this.image,
          command: ["sh", "-c", script],
          args: [],
          volumes: useTls
            ? [{ name: "certs", secret: { secretName: this.tls.secretName } }]
            : undefined,
          volumeMounts: useTls
            ? [{ name: "certs", mountPath: CERTS_MOUNT, readOnly: true }]
            : undefined,
        },
      },
      onLog,
      signal,
    );
  }
}

/** Pure `buildctl build` argv construction (unit-tested). */
export function buildctlArgs(
  req: ImageBuildRequest,
  endpoint: string,
  tls: { secretName: string; serverName: string },
): string[] {
  const args = ["--addr", endpoint];

  if (tls.secretName) {
    args.push(
      "--tlscacert",
      `${CERTS_MOUNT}/ca.crt`,
      "--tlscert",
      `${CERTS_MOUNT}/tls.crt`,
      "--tlskey",
      `${CERTS_MOUNT}/tls.key`,
    );
    if (tls.serverName) args.push("--tlsservername", tls.serverName);
  }

  args.push(
    "build",
    "--frontend",
    "dockerfile.v0",
    "--local",
    `context=${WORKSPACE_DIR}`,
    "--local",
    `dockerfile=${WORKSPACE_DIR}`,
    "--opt",
    `platform=${config.imageBuilder.platform ?? "linux/amd64"}`,
  );

  for (const [key, value] of Object.entries(req.buildArgs ?? {})) {
    args.push("--opt", `build-arg:${key}=${value}`);
  }

  // `oci-mediatypes`/`image-manifest` force a single OCI manifest (not a
  // manifest LIST): the bundled Zot registry rejects the buildx default
  // multi-manifest index, so these two are required for the push to land.
  const output =
    `type=image,name=${req.tag},push=true` +
    ",oci-mediatypes=true,image-manifest=true" +
    (req.insecureRegistry ? ",registry.insecure=true" : "");
  args.push("--output", output);

  if (req.cacheRepo) {
    args.push(
      "--export-cache",
      `type=registry,ref=${req.cacheRepo},mode=max`,
      "--import-cache",
      `type=registry,ref=${req.cacheRepo}`,
    );
  }

  args.push("--metadata-file", "/tmp/atelier-md.json");
  return args;
}
