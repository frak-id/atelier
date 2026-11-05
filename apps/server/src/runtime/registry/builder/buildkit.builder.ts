/**
 * BuildKit implementation of `ImageBuilderBackend`: dispatches to an existing
 * `buildkitd` daemon (`config.imageBuilder.endpoint`, required) via a tiny
 * one-shot `buildctl` client Job (see `./k8s-build-job.ts`).
 *
 * The client runs `buildctl build` against the unpacked workspace, pushes to
 * `req.tag`, writes build metadata to a temp file, then greps the pushed
 * digest out of it into `/dev/termination-log` for the Job runner. Optional
 * mTLS to the daemon is mounted from `config.imageBuilder.tls`.
 */

import { imageBuilderConfig } from "../../../shared/lib/runtime-config.ts";
import {
  formatBuildArgs,
  type ImageBuilderBackend,
  type ImageBuildRequest,
  type ImageBuildResult,
  shQuote,
} from "./builder.types.ts";
import {
  BUILD_CONTEXT_DIR,
  type BuildContainerSpec,
  jobResourceName,
  runKubeBuildJob,
} from "./k8s-build-job.ts";

// Pinned to the latest moby/buildkit release (checked 2026-09-23) — a
// floating `:latest` would silently pick up upstream breakage on every
// build. Bump deliberately when upgrading.
const BUILDKIT_VERSION = "v0.33.0";
/** `buildctl` client image (talks to the external `buildkitd`). */
const DEFAULT_BUILDKIT_CLIENT_IMAGE = `moby/buildkit:${BUILDKIT_VERSION}`;
const CERTS_MOUNT = "/certs";

export interface BuildkitImageBuilderOptions {
  /** buildkitd address, e.g. `tcp://buildkitd.buildkit.svc:1234`. */
  endpoint: string;
  /** Builder image override (`config.imageBuilder.image`). Empty picks the
   * pinned `buildctl` client image. */
  image?: string;
  /** mTLS to the daemon (`config.imageBuilder.tls`). */
  tls?: { secretName?: string; serverName?: string };
}

/**
 * Pure construction of the build container's `BuildContainerSpec` (image,
 * command, args, env, securityContext, TLS volumes) — unit-tested
 * separately from the Job submit/watch machinery in `runKubeBuildJob`.
 */
export function buildkitContainerSpec(
  req: ImageBuildRequest,
  options: {
    endpoint: string;
    image: string;
    tls: { secretName: string; serverName: string };
  },
): BuildContainerSpec {
  const { endpoint, image, tls } = options;
  const args = buildctlArgs(req, endpoint, tls);
  // buildctl writes metadata to a file; pin the MANIFEST digest
  // (`containerimage.digest`) into the termination log the shared runner
  // reads back. NOT the first sha256 in the file — that's
  // `containerimage.config.digest`, and pinning the config blob makes
  // containerd reject the pull ("unexpected media type
  // application/vnd.oci.image.config.v1+json"). The key match tolerates an
  // optional space after the colon so it works on compact or pretty JSON.
  // H1: every interpolated value (in particular `req.buildArgs`
  // key/values, which flow straight from the API request) MUST be shell-
  // quoted before landing in this `sh -c` script — unreachable today (no
  // caller sets `buildArgs`), but the port advertises the field and this
  // is the one backend that actually shells out through `sh -c`.
  const script =
    `set -e; buildctl ${args.map(shQuote).join(" ")}; ` +
    'grep -o \'"containerimage\\.digest": *"sha256:[0-9a-f]\\{64\\}"\' ' +
    "/tmp/atelier-md.json | grep -o 'sha256:[0-9a-f]\\{64\\}' " +
    "> /dev/termination-log";

  const useTls = tls.secretName.length > 0;
  return {
    image,
    command: ["sh", "-c", script],
    args: [],
    volumes: useTls
      ? [{ name: "certs", secret: { secretName: tls.secretName } }]
      : undefined,
    volumeMounts: useTls
      ? [{ name: "certs", mountPath: CERTS_MOUNT, readOnly: true }]
      : undefined,
  };
}

export class BuildkitImageBuilder implements ImageBuilderBackend {
  private readonly endpoint: string;
  private readonly image: string;
  private readonly tls: { secretName: string; serverName: string };

  constructor(options: BuildkitImageBuilderOptions) {
    this.endpoint = options.endpoint;
    this.tls = {
      secretName: options.tls?.secretName ?? "",
      serverName: options.tls?.serverName ?? "",
    };
    this.image = options.image || DEFAULT_BUILDKIT_CLIENT_IMAGE;
  }

  async build(
    req: ImageBuildRequest,
    onLog: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<ImageBuildResult> {
    return runKubeBuildJob(
      {
        name: jobResourceName(req.tag),
        contextDir: req.contextDir,
        dockerfile: req.dockerfile,
        container: buildkitContainerSpec(req, {
          endpoint: this.endpoint,
          image: this.image,
          tls: this.tls,
        }),
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
    `context=${BUILD_CONTEXT_DIR}`,
    "--local",
    `dockerfile=${BUILD_CONTEXT_DIR}`,
    "--opt",
    `platform=${imageBuilderConfig().platform}`,
  );

  args.push(
    ...formatBuildArgs(req.buildArgs, (key, value) => [
      "--opt",
      `build-arg:${key}=${value}`,
    ]),
  );

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
