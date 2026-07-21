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
import { imageBuilderConfig } from "../../../shared/lib/runtime-config.ts";
import { docker, dockerStream } from "../../backend/docker-cli.ts";
import {
  formatBuildArgs,
  type ImageBuilderBackend,
  type ImageBuildRequest,
  type ImageBuildResult,
} from "./builder.types.ts";

const log = createChildLogger("image-builder-docker");

/** Strip a `:tag` suffix off a full image reference, leaving the bare repo
 * (`registry[:port]/name`). Only strips a colon that comes AFTER the last
 * `/`, so a registry host's own port (`localhost:5000/name:latest`) is left
 * alone. */
function tagRepo(tag: string): string {
  const lastSlash = tag.lastIndexOf("/");
  const lastColon = tag.lastIndexOf(":");
  if (lastColon > lastSlash) return tag.slice(0, lastColon);
  return tag;
}

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
        imageBuilderConfig().platform,
        "-t",
        req.tag,
        "-f",
        dockerfilePath,
      ];
      buildArgs.push(
        ...formatBuildArgs(req.buildArgs, (key, value) => [
          "--build-arg",
          `${key}=${value}`,
        ]),
      );
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

  /** `docker inspect` reports EVERY digest the daemon has ever pushed/pulled
   * for this image content under `RepoDigests` (`<repo>@sha256:...`), one
   * entry per distinct repo the same content landed in — not just `req.tag`'s
   * repo. Taking `[0]` unconditionally (H3) could pin a digest from a
   * DIFFERENT repo if the same layers were previously pushed there on this
   * daemon. Filter to the entry whose repo prefix matches `tag`'s repo
   * (everything before the last `:`, which strips the tag but not a port)
   * before extracting the `sha256:...` suffix. */
  private async resolveDigest(tag: string): Promise<string> {
    const result = await docker(
      ["inspect", "--format", "{{json .RepoDigests}}", tag],
      this.dockerBin,
      this.env,
    );
    if (result.code !== 0) {
      throw new Error(
        `failed to resolve pushed digest for ${tag}: ${result.stderr}`,
      );
    }
    const repoDigests = JSON.parse(result.stdout.trim()) as unknown;
    if (!Array.isArray(repoDigests)) {
      throw new Error(
        `unexpected docker inspect output for ${tag}: "${result.stdout.trim()}"`,
      );
    }
    const repo = tagRepo(tag);
    const match = repoDigests.find(
      (entry): entry is string =>
        typeof entry === "string" && entry.startsWith(`${repo}@`),
    );
    if (!match) {
      throw new Error(
        `no RepoDigests entry for repo "${repo}" (tag ${tag}) among: ` +
          JSON.stringify(repoDigests),
      );
    }
    const at = match.lastIndexOf("@");
    if (at === -1 || !match.slice(at + 1).startsWith("sha256:")) {
      throw new Error(
        `unexpected docker inspect RepoDigests entry for ${tag}: "${match}"`,
      );
    }
    return match.slice(at + 1);
  }
}
