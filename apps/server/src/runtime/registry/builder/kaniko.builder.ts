/**
 * Kaniko implementation of `ImageBuilderBackend` — the zero-daemon,
 * cluster-native builder. Runs `gcr.io/kaniko-project/executor` as a one-shot
 * Job (see `./k8s-build-job.ts`) that builds the context unpacked at
 * `WORKSPACE_DIR` and pushes to `req.tag`. Unlike the docker backend this
 * needs NO Docker socket / external daemon, so it's the right fit for a stock
 * k3s node — kaniko does the build in userspace inside its own pod.
 *
 * Kaniko writes the pushed digest to `/dev/termination-log` via `--digest-file`
 * so the shared runner reads it straight off pod status. `insecureRegistry`
 * maps to kaniko's `--insecure` / `--skip-tls-verify` flags (the bundled Zot
 * registry is plain HTTP); `cacheRepo` enables `--cache` against that repo.
 */
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

const DEFAULT_KANIKO_IMAGE = "gcr.io/kaniko-project/executor:latest";

export interface KanikoImageBuilderOptions {
  /** Executor image override (`config.imageBuilder.image`). */
  image?: string;
}

export class KanikoImageBuilder implements ImageBuilderBackend {
  private readonly image: string;

  constructor(options: KanikoImageBuilderOptions = {}) {
    this.image = options.image || DEFAULT_KANIKO_IMAGE;
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
        container: { image: this.image, args: kanikoArgs(req) },
      },
      onLog,
      signal,
    );
  }
}

/** Pure kaniko `--flag` construction (unit-tested). */
export function kanikoArgs(req: ImageBuildRequest): string[] {
  const args = [
    `--context=dir://${WORKSPACE_DIR}`,
    `--dockerfile=${WORKSPACE_DIR}/Dockerfile`,
    `--destination=${req.tag}`,
    // Bare pushed digest → termination message → shared runner reads it back.
    "--digest-file=/dev/termination-log",
    `--custom-platform=${config.imageBuilder.platform ?? "linux/amd64"}`,
  ];

  for (const [key, value] of Object.entries(req.buildArgs ?? {})) {
    args.push(`--build-arg=${key}=${value}`);
  }

  if (req.insecureRegistry) {
    args.push(
      "--insecure",
      "--insecure-pull",
      "--skip-tls-verify",
      "--skip-tls-verify-pull",
    );
  }

  if (req.cacheRepo) {
    args.push("--cache=true", `--cache-repo=${req.cacheRepo}`);
  }

  return args;
}
