/**
 * BuildKit implementation of `ImageBuilderBackend`. Two modes, selected by
 * whether `config.imageBuilder.endpoint` is set:
 *
 *   - endpoint SET: dispatch to an EXISTING `buildkitd` daemon via a tiny
 *     one-shot `buildctl` client Job (see `./k8s-build-job.ts`) — the
 *     multi-tenant-friendly answer the docker backend's security note
 *     points at, for a cluster that already hosts a shared buildkitd Pod.
 *   - endpoint EMPTY (the default): run BuildKit itself daemonless, inside
 *     the same one-shot Job, using the rootless image's bundled
 *     `buildctl-daemonless.sh` (spawns an ephemeral `buildkitd` via
 *     RootlessKit, waits for it, then runs `buildctl` against it — see
 *     https://github.com/moby/buildkit/blob/master/docs/rootless.md). This
 *     needs NO external daemon or Docker socket, same as kaniko, but stays
 *     on the actively-maintained BuildKit codebase (upstream Kaniko was
 *     archived by Google in 2025). Rootless BuildKit needs to create
 *     user/mount namespaces inside its own unprivileged container, which
 *     the default seccomp/AppArmor profiles both block and the default
 *     restrictive `securityContext` doesn't allow — see
 *     `ROOTLESS_SECURITY_CONTEXT` below, lifted straight from upstream's
 *     `examples/kubernetes/pod.rootless.yaml`. Build Jobs never set
 *     `runtimeClassName` (only sandbox pods do, via `kube.resources.ts` →
 *     `config.kubernetes.runtimeClass`), so they run under the node's
 *     default (runc) container runtime, not Kata — the Unconfined
 *     seccomp/AppArmor profiles below apply to an ordinary runc container,
 *     not a Kata VM, and don't need any Kata-specific handling.
 *
 * Either way the client runs `buildctl build` against the unpacked
 * workspace, pushes to `req.tag`, writes build metadata to a temp file,
 * then greps the pushed digest out of it into `/dev/termination-log` for
 * the shared runner. Optional mTLS to an external daemon is mounted from
 * `config.imageBuilder.tls` (endpoint mode only — daemonless has no remote
 * daemon to authenticate to).
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
  type BuildContainerSpec,
  jobResourceName,
  runKubeBuildJob,
  WORKSPACE_DIR,
} from "./k8s-build-job.ts";

// Pinned to the latest moby/buildkit release (checked 2026-09-23) — a
// floating `:latest` would silently pick up upstream breakage on every
// build. Bump deliberately when upgrading.
const BUILDKIT_VERSION = "v0.33.0";
/** `buildctl` client only — talks to an existing `buildkitd` (endpoint mode). */
const DEFAULT_BUILDKIT_CLIENT_IMAGE = `moby/buildkit:${BUILDKIT_VERSION}`;
/** Rootless variant bundling `buildctl-daemonless.sh` (daemonless mode). */
const DEFAULT_BUILDKIT_ROOTLESS_IMAGE = `moby/buildkit:${BUILDKIT_VERSION}-rootless`;
const CERTS_MOUNT = "/certs";

/**
 * The exact `securityContext` upstream's own Kubernetes rootless example
 * (`examples/kubernetes/pod.rootless.yaml`) documents as required:
 * seccomp/AppArmor Unconfined so the daemon can `unshare`/`mount` inside its
 * own unprivileged container, and the fixed non-root `1000:1000` the
 * rootless image's `USER` directive bakes in (changing it needs a rebuilt
 * image). `appArmorProfile` needs Kubernetes >= 1.30; `seccompProfile` needs
 * >= 1.19 — both satisfied by any current k3s.
 */
const ROOTLESS_SECURITY_CONTEXT = {
  seccompProfile: { type: "Unconfined" },
  appArmorProfile: { type: "Unconfined" },
  runAsUser: 1000,
  runAsGroup: 1000,
};

export interface BuildkitImageBuilderOptions {
  /** buildkitd address, e.g. `tcp://buildkitd.buildkit.svc:1234`. Empty (the
   * default) runs BuildKit daemonless in the build Job itself — no external
   * daemon needed. */
  endpoint?: string;
  /** Builder image override (`config.imageBuilder.image`). Empty picks the
   * per-mode default (client image when `endpoint` is set, rootless image
   * when it's daemonless). */
  image?: string;
  /** mTLS to the daemon (`config.imageBuilder.tls`). Only meaningful with an
   * `endpoint` — daemonless mode has no remote daemon to authenticate to. */
  tls?: { secretName?: string; serverName?: string };
}

/** Resolve the default builder image for the given endpoint/override — a
 * pure helper split out of the constructor purely so it's unit-testable
 * without spinning up a builder instance. */
export function resolveBuildkitImage(
  endpoint: string,
  imageOverride: string,
): string {
  if (imageOverride) return imageOverride;
  return endpoint
    ? DEFAULT_BUILDKIT_CLIENT_IMAGE
    : DEFAULT_BUILDKIT_ROOTLESS_IMAGE;
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
  const daemonless = endpoint.length === 0;
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
  // Daemonless mode swaps the `buildctl` binary for the rootless image's
  // bundled `buildctl-daemonless.sh`, which spawns its own ephemeral
  // `buildkitd` (via `BUILDKIT_HOST`/`$XDG_RUNTIME_DIR` baked into the
  // image, no `--addr` needed — `buildctlArgs` already omits `--addr` when
  // `endpoint` is empty) before forwarding the same argv to `buildctl`.
  const binary = daemonless ? "buildctl-daemonless.sh" : "buildctl";
  const script =
    `set -e; ${binary} ${args.map(shQuote).join(" ")}; ` +
    'grep -o \'"containerimage\\.digest": *"sha256:[0-9a-f]\\{64\\}"\' ' +
    "/tmp/atelier-md.json | grep -o 'sha256:[0-9a-f]\\{64\\}' " +
    "> /dev/termination-log";

  const useTls = tls.secretName.length > 0;
  return {
    image,
    command: ["sh", "-c", script],
    args: [],
    // buildkitd's OCI worker needs `--oci-worker-no-process-sandbox` in a
    // container runtime (Kubernetes has no equivalent of Docker's
    // `--security-opt systempaths=unconfined`) — see the file header.
    env: daemonless
      ? [
          {
            name: "BUILDKITD_FLAGS",
            value: "--oci-worker-no-process-sandbox",
          },
        ]
      : undefined,
    securityContext: daemonless ? ROOTLESS_SECURITY_CONTEXT : undefined,
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

  constructor(options: BuildkitImageBuilderOptions = {}) {
    this.endpoint = options.endpoint ?? "";
    this.tls = {
      secretName: options.tls?.secretName ?? "",
      serverName: options.tls?.serverName ?? "",
    };
    this.image = resolveBuildkitImage(this.endpoint, options.image ?? "");
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
  // Daemonless mode has no remote address to dial — `buildctl-daemonless.sh`
  // talks to the ephemeral `buildkitd` it spawns via the image's baked-in
  // `BUILDKIT_HOST` env var instead.
  const args = endpoint ? ["--addr", endpoint] : [];

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
