/**
 * Docker-daemon implementation of `ImageBuilderBackend` — the first, lowest-
 * friction builder (default `config.imageBuilder.kind`). Shells out to the
 * `docker` CLI exactly like the sandbox Docker backend does
 * (`../../backend/docker-cli.ts`): `docker build` then `docker push`, then
 * resolve the pushed digest. Works against any local socket or a remote
 * `tcp://` daemon (`config.imageBuilder.dockerHost` \u2192 `DOCKER_HOST`).
 *
 * Security note (see the design review): a shared/remote docker daemon is a
 * root-equivalent RCE surface for whoever can submit a build — arbitrary
 * `RUN` steps execute as the daemon's own privileges. Fine as the first/dev
 * target; multi-tenant deployments should move to buildkit-rootless or
 * kaniko once those backends exist.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChildLogger } from "../../../shared/lib/logger.ts";
import { docker, dockerStream } from "../../backend/docker-cli.ts";
import type {
  ImageBuilderBackend,
  ImageBuildRequest,
  ImageBuildResult,
} from "./builder.types.ts";

const log = createChildLogger("image-builder-docker");

export interface DockerImageBuilderOptions {
  /** Docker daemon URL, e.g. `tcp://host:2375`. Empty inherits the process's
   * own `DOCKER_HOST` / default local socket. */
  dockerHost?: string;
  dockerBin?: string;
}

export class DockerImageBuilder implements ImageBuilderBackend {
  private readonly env: Record<string, string> | undefined;
  private readonly dockerBin: string;

  constructor(options: DockerImageBuilderOptions = {}) {
    this.env = options.dockerHost
      ? { DOCKER_HOST: options.dockerHost }
      : undefined;
    this.dockerBin = options.dockerBin ?? "docker";
  }

  // `req.insecureRegistry` / `req.cacheRepo` are no-ops for this backend: a
  // docker daemon's insecure-registry allowlist is daemon-config, not a
  // per-build flag, and `docker build` has no BuildKit-style remote cache
  // import/export without enabling the buildx/buildkit driver. Both fields
  // exist on the port for the buildkit/kaniko backends that DO honor them.
  async build(
    req: ImageBuildRequest,
    onLog: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<ImageBuildResult> {
    // A temp Dockerfile OUTSIDE `req.contextDir` — never write into a seed's
    // own directory (it's shared, read-only build content) or an unpacked
    // upload the caller may reuse/inspect. `-f` points `docker build` at it
    // while `req.contextDir` stays the actual build context.
    const dockerfileDir = await mkdtemp(join(tmpdir(), "atelier-image-build-"));
    const dockerfilePath = join(dockerfileDir, `Dockerfile.${randomUUID()}`);
    await writeFile(dockerfilePath, req.dockerfile, "utf8");

    try {
      const buildArgs: string[] = [
        "build",
        "--platform",
        "linux/amd64",
        "-t",
        req.tag,
        "-f",
        dockerfilePath,
      ];
      for (const [key, value] of Object.entries(req.buildArgs ?? {})) {
        buildArgs.push("--build-arg", `${key}=${value}`);
      }
      buildArgs.push(req.contextDir);

      onLog(`$ docker ${buildArgs.join(" ")}\n`);
      const buildCode = await dockerStream(buildArgs, onLog, {
        bin: this.dockerBin,
        env: this.env,
        signal,
      });
      if (buildCode !== 0) {
        throw new Error(`docker build exited with code ${buildCode}`);
      }
      if (signal.aborted) throw new Error("image build aborted");

      onLog(`$ docker push ${req.tag}\n`);
      const pushCode = await dockerStream(["push", req.tag], onLog, {
        bin: this.dockerBin,
        env: this.env,
        signal,
      });
      if (pushCode !== 0) {
        throw new Error(`docker push exited with code ${pushCode}`);
      }
      if (signal.aborted) throw new Error("image build aborted");

      const digest = await this.resolveDigest(req.tag);
      log.info({ tag: req.tag, digest }, "image built and pushed");
      return { digest };
    } finally {
      await rm(dockerfileDir, { recursive: true, force: true });
    }
  }

  /** `docker inspect` reports the digest of the manifest just pushed under
   * `RepoDigests` (`<repo>@sha256:...`) — more reliable across daemon
   * versions than parsing push output. Extracts only the `sha256:...` part
   * so the service can pin `${tag-without-suffix}@${digest}` uniformly with
   * how `ImageRegistryService.resolveImageReference` already resolves refs. */
  private async resolveDigest(tag: string): Promise<string> {
    const result = await docker(
      ["inspect", "--format", "{{index .RepoDigests 0}}", tag],
      this.dockerBin,
      this.env,
    );
    if (result.code !== 0) {
      throw new Error(
        `failed to resolve pushed digest for ${tag}: ${result.stderr}`,
      );
    }
    const repoDigest = result.stdout.trim();
    const at = repoDigest.lastIndexOf("@");
    if (at === -1 || !repoDigest.slice(at + 1).startsWith("sha256:")) {
      throw new Error(
        `unexpected docker inspect output for ${tag}: "${repoDigest}"`,
      );
    }
    return repoDigest.slice(at + 1);
  }
}
