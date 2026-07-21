/**
 * The image builder's backend port — mirrors the split documented in
 * `../../backend/backend.types.ts` for `SandboxBackend`/`VolumeBackend`:
 * this interface is the ONLY thing a concrete builder (docker daemon,
 * buildkit, kaniko) implements, and it is deliberately narrow. Every policy
 * decision lives one layer up, in `ImageBuilderService` (not yet built — see
 * the seed loader's header comment):
 *
 *   - Dockerfile `FROM`/`COPY --from` rewriting (seed `substitutions`,
 *     resolved via `ImageRegistryService.resolveImageReference` so a base
 *     image's digest stays consistent with how prebuilds key their content
 *     hash) — the backend receives already-rewritten Dockerfile CONTENT, it
 *     never reads a seed's raw Dockerfile off disk itself.
 *   - Seed build-DAG ordering (`dependsOn`), content/name dedupe (mirrors
 *     `RuntimeService`'s `inflightPrebuilds` map), digest pinning after
 *     push, and the `images` table bookkeeping (status/log/error).
 *   - Build-context materialization: a seed's `contextDir` used as-is, a zip
 *     upload unpacked to a temp dir, or a single pasted Dockerfile wrapped in
 *     a synthetic one-file context — the backend only ever sees a ready
 *     `contextDir` on disk, never an upload/seed-id.
 *
 * A concrete backend's ONLY job: build `dockerfile` against `contextDir`,
 * push to `tag`, and return the pushed manifest's digest. Backends differ
 * wildly in how a build context reaches them (docker streams it to a local
 * daemon; buildkit's `buildctl` sends it `--local`; kaniko needs it staged
 * into the cluster, e.g. a ConfigMap mounted into a Job pod) — that
 * difference is fully absorbed inside each backend's `build()`, never
 * surfaced in this port.
 */

export interface ImageBuildRequest {
  /** Absolute path to a build context directory already prepared by
   * `ImageBuilderService` (seed copy, unpacked zip, or a synthetic
   * single-Dockerfile context). Handed to the backend verbatim. */
  contextDir: string;
  /** Full Dockerfile CONTENT to build — already rewritten (seed
   * substitutions resolved) by the service. Backends must write this to
   * disk themselves (e.g. as a sibling file inside `contextDir`); they must
   * NOT read any `Dockerfile` that may already exist in `contextDir`. */
  dockerfile: string;
  /** Full destination ref to build+push, e.g. `${registry}/dev-base:latest`,
   * or a bare local tag (`dev-base:latest`) when {@link local} is set. */
  tag: string;
  /** Local Docker mode: no external registry is configured, so build into the
   * local daemon and do NOT push. The returned digest is the local image ID
   * (content identity for bookkeeping) rather than a pushed manifest digest;
   * the service stores the bare tag as the image ref. Only the docker backend
   * honors this — kaniko/buildkit always target a registry. */
  local?: boolean;
  /** Build-time `--build-arg`s. MUST NOT carry secrets — they land in the
   * image's build history. Use the backend's own credential mechanism for
   * anything sensitive (mirrors the prebuild path's transient, non-baked
   * `githubToken` injection). */
  buildArgs?: Record<string, string>;
  /** Treat the destination/cache registry as insecure (HTTP / self-signed).
   * From `config.imageBuilder.insecureRegistry`. A backend for which this is
   * meaningless (e.g. a local docker daemon relying on its own registry
   * config) may ignore it — document that choice where it does. */
  insecureRegistry: boolean;
  /** Optional build-cache repository (`config.imageBuilder.cacheRepo`). */
  cacheRepo?: string;
}

export interface ImageBuildResult {
  /** The pushed manifest's digest, `sha256:<hex>` — the service pins this
   * into the `images` row so later spawns/prebuilds resolve a stable
   * reference instead of re-resolving `:latest` on every use. */
  digest: string;
}

export interface ImageBuilderBackend {
  /**
   * Build `req.dockerfile` against `req.contextDir` and push to `req.tag`.
   * `onLog` streams raw build output chunks as they arrive (builds are
   * minutes long — callers surface this over an async job's `/logs`
   * endpoint, never buffer-then-return). `signal` aborts an in-flight build
   * (e.g. server shutdown, an explicit cancel) — backends must kill any
   * spawned process/job promptly when it fires.
   */
  build(
    req: ImageBuildRequest,
    onLog: (chunk: string) => void,
    signal: AbortSignal,
  ): Promise<ImageBuildResult>;
}

/** Single-quote a shell argument (POSIX), escaping embedded single quotes —
 * the same scheme `runtime.service.ts`'s `shellQuote` and the agent's
 * `sh_quote` (Rust) use. Only the buildkit backend currently needs this (its
 * `buildctl` invocation runs through `sh -c`); docker/kaniko pass args
 * straight to argv (no shell involved) so they don't need quoting, but they
 * still go through {@link formatBuildArgs} for a single shared loop. */
export function shQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Shared `req.buildArgs` → argv-flag formatting loop, used by all three
 * backends (H2): each backend differs only in the flag SHAPE it wants per
 * key/value pair (`--build-arg k=v`, `--build-arg=k=v`, `--opt
 * build-arg:k=v`), supplied via `formatFlag`. Centralizing the loop means a
 * quoting fix (H1) or a future encoding change only needs to happen once. */
export function formatBuildArgs(
  buildArgs: Record<string, string> | undefined,
  formatFlag: (key: string, value: string) => string[],
): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(buildArgs ?? {})) {
    out.push(...formatFlag(key, value));
  }
  return out;
}
