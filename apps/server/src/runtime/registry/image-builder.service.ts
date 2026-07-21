/**
 * The image builder's POLICY layer — mirrors `RuntimeService`'s split with
 * `SandboxBackend`/`VolumeBackend`: this service owns every decision an
 * `ImageBuilderBackend` must never make (Dockerfile rewriting, build-DAG
 * ordering, dedupe, digest pinning, `images` table bookkeeping); the backend
 * only builds+pushes what it's handed (`builder.types.ts`'s header comment).
 *
 * Three provenances, one surface (see the design review this implements):
 *   - `seed`: an embedded Dockerfile+context (`../seeds/`) the operator
 *     builds in their own cluster — `buildSeed`.
 *   - `dockerfile`: a user-supplied Dockerfile (pasted or a zip upload) —
 *     `buildDockerfile`.
 *   - `external`: a bring-your-own image reference (e.g. GHCR) used
 *     verbatim, no build — `registerExternal`.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotFoundError, ValidationError } from "../../shared/errors.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import {
  agentImage,
  imageBuilderConfig,
} from "../../shared/lib/runtime-config.ts";
import type { ImageRecord, ImageStore } from "../store.ts";
import type { ImageBuilderBackend } from "./builder/index.ts";
import { ImageRegistryService } from "./image-registry.service.ts";
import { getSeed, loadSeeds, type SeedManifest } from "./seeds/index.ts";

const log = createChildLogger("image-builder-service");

/** Single-segment image name: lowercase alnum plus `.`/`_`/`-` separators,
 * no slashes and no `@` — mirrors `ToolsetRefSchema`'s token grammar
 * (`packages/spec/src/toolset-spec.ts`) but without the `/` nesting a
 * toolset ref allows, because an image name is never hierarchical and must
 * never be able to smuggle a registry host or a tag/digest suffix into the
 * push destination (security review R-push-scope). */
const IMAGE_NAME_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)*$/;

/** Bound on a single build's wall-clock time — matches the k8s builders'
 * own `BUILD_TIMEOUT_MS` (`k8s-build-job.ts`; NOT imported from there, this
 * is the docker-backend's independent bound so a hung `docker build`/`push`
 * against a wedged daemon doesn't wedge the `inflight` dedupe entry forever;
 * see C1). */
const BUILD_TIMEOUT_MS = 30 * 60_000;

/** Number of build-log lines kept in `ImageRecord.buildLog`. */
const LOG_TAIL_LINES = 500;
/** Persist the rolling log to the store at most this often while a build is
 * in flight, so a chatty build (apt output, curl progress) doesn't thrash
 * sqlite on every chunk. The final state is always flushed on completion. */
const LOG_FLUSH_INTERVAL_MS = 1000;

function assertValidName(name: string): void {
  if (!IMAGE_NAME_PATTERN.test(name)) {
    throw new ValidationError(
      `Invalid image name '${name}': must be lowercase alphanumeric with ` +
        "'.', '_', '-' separators only (no '/', no tag/digest suffix).",
    );
  }
}

export interface ImageBuilderDeps {
  store: ImageStore;
  /** Factory, not an instance: the backend is (re)selected per build so a
   * live edit to the image-builder config (kind/endpoint/…) applies to the
   * next build without a restart. */
  builder: () => ImageBuilderBackend;
  /** Read lazily so a live edit to the registry URL applies immediately. */
  registryUrl: () => string;
  /** Every image reference a live sandbox or stored snapshot still points
   * at — the delete guard's referenced-set (mirrors `RuntimeService`'s
   * `referencedSnapshotRefs`). Called lazily so it always reflects current
   * runtime state. */
  referencedImageRefs: () => string[];
  /** Observability hook: called once per newly-started build with the image
   * name and the promise that settles when the build finishes. The api/ seam
   * wires this to `JobService` so image builds appear in the durable job feed
   * without this service ever depending on the jobs layer. */
  onBuildStarted?: (name: string, done: Promise<ImageRecord>) => void;
}

export class ImageBuilderService {
  private readonly store: ImageStore;
  private readonly builder: () => ImageBuilderBackend;
  private readonly registryUrl: () => string;
  private readonly referencedImageRefs: () => string[];
  private readonly onBuildStarted?: (
    name: string,
    done: Promise<ImageRecord>,
  ) => void;
  /** De-dupes concurrent builds of the same destination name onto one
   * execution — mirrors `RuntimeService.inflightPrebuilds`. */
  private readonly inflight = new Map<string, Promise<ImageRecord>>();

  constructor(deps: ImageBuilderDeps) {
    this.store = deps.store;
    this.builder = deps.builder;
    this.registryUrl = deps.registryUrl;
    this.referencedImageRefs = deps.referencedImageRefs;
    this.onBuildStarted = deps.onBuildStarted;
  }

  // ── reads ──────────────────────────────────────────────────────────────

  /** The embedded seeds, minus their on-disk `contextDir` (an absolute host
   * path that has no meaning to an API client and shouldn't leak). */
  listTemplates(): Omit<SeedManifest, "contextDir">[] {
    return loadSeeds().map((seed) => {
      const { contextDir: _omit, ...rest } = seed;
      return rest;
    });
  }

  listImages(): ImageRecord[] {
    return [...this.store.list()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  getImage(name: string): ImageRecord | undefined {
    return this.store.get(name);
  }

  getBuildLog(name: string): string {
    return this.store.get(name)?.buildLog ?? "";
  }

  // ── seed build ─────────────────────────────────────────────────────────

  /**
   * Build an embedded seed and push it to the operator's own registry.
   * Returns immediately with the `building` record (the route answers
   * `202`); poll `getImage`/`getBuildLog` for progress. Parents in
   * `dependsOn` must already be a `ready` image row — this method never
   * auto-builds them (explicit-only DAG policy, design review R2).
   */
  async buildSeed(
    seedId: string,
    options: { force?: boolean } = {},
  ): Promise<ImageRecord> {
    const seed = getSeed(seedId);
    if (!seed) throw new NotFoundError("Seed", seedId);

    if (!options.force) {
      const existing = this.store.get(seedId);
      if (existing && existing.status !== "error") return existing;
    }

    for (const parentName of seed.dependsOn) {
      const parent = this.store.get(parentName);
      if (!parent || parent.status !== "ready") {
        throw new ValidationError(
          `Seed '${seedId}' depends on '${parentName}', which has not been ` +
            `built yet. Build '${parentName}' first.`,
        );
      }
    }

    const inflight = this.inflight.get(seedId);
    if (inflight) return this.store.get(seedId) ?? inflight;

    const dockerfile = await this.rewriteSeedDockerfile(seed);
    const record = this.beginBuild({
      name: seedId,
      provenance: "seed",
      seedId,
    });
    // A seed's `contextDir` is permanent embedded content — NEVER cleaned up
    // (no cleanup callback), unlike a BYO/zip context.
    //
    // `AGENT_IMAGE`: the base seeds bake the in-pod agent via `COPY --from=
    // ${AGENT_IMAGE}` (see dev-base's Dockerfile). Passing it here lets an
    // operator repoint the agent at a private/mirrored ref via config; the
    // Dockerfile's own default (public GHCR) covers the common case. Harmless
    // for seeds that declare no such ARG (an unused build-arg is just a warn).
    const run = this.executeBuild(record, {
      contextDir: seed.contextDir,
      dockerfile,
      buildArgs: { AGENT_IMAGE: agentImage() },
    }).finally(() => {
      this.inflight.delete(seedId);
    });
    this.inflight.set(seedId, run);
    this.onBuildStarted?.(record.name, run);
    // Async: return the `building` record now and let the build run in the
    // background (executeBuild never rejects — it records error state). The
    // route answers 202; clients poll getImage/getBuildLog for progress.
    return record;
  }

  /** Resolve a seed's `substitutions` (`FROM`/`COPY --from` tokens pointing
   * at another seed's resulting image or the in-pod agent image) to
   * digest-pinned refs via `ImageRegistryService.resolveImageReference` —
   * the SAME resolver `resolveSource`/`resolveContentKey` use, so a
   * rebuilt base image's digest stays consistent with how prebuilds key
   * their content hash (design review §5). */
  private async rewriteSeedDockerfile(seed: SeedManifest): Promise<string> {
    let dockerfile = await readFile(
      join(seed.contextDir, "Dockerfile"),
      "utf8",
    );
    for (const sub of seed.substitutions) {
      const resolved = await ImageRegistryService.resolveImageReference(
        sub.seed,
      );
      if (!dockerfile.includes(sub.token)) {
        throw new ValidationError(
          `Seed '${seed.id}' declares substitution token '${sub.token}' ` +
            "but it was not found in the Dockerfile (seed drifted out of " +
            "sync with its image.json).",
        );
      }
      dockerfile = dockerfile.split(sub.token).join(resolved);
    }
    return dockerfile;
  }

  // ── BYO dockerfile build ──────────────────────────────────────────────

  /**
   * Build a user-supplied Dockerfile (pasted text, or a zip upload already
   * unpacked to `contextDir` by the route layer) and push it to the
   * operator's registry under `${registryUrl}/${name}`. Never lets the
   * request pick an arbitrary push destination (security review) — `name`
   * is validated and the tag is always derived from it, not from anything
   * inside the Dockerfile or the caller-supplied `contextDir`.
   */
  async buildDockerfile(
    name: string,
    dockerfile: string,
    contextDir?: string,
  ): Promise<ImageRecord> {
    assertValidName(name);
    // Take ownership of the build context and delete it once the build
    // settles (success or failure). A caller-supplied unpacked-zip dir OR a
    // synthetic empty dir for pasted text (docker build always needs SOME
    // context dir even when the Dockerfile references nothing in it). The
    // route must NOT clean a context it handed us on the success path — the
    // background build still needs it after this method returns.
    const context =
      contextDir ?? (await mkdtemp(join(tmpdir(), "atelier-image-context-")));
    const cleanup = () => rm(context, { recursive: true, force: true });

    const inflight = this.inflight.get(name);
    if (inflight) {
      // A build for this name is already running; drop the redundant context
      // and return the in-flight record.
      await cleanup();
      return this.store.get(name) ?? inflight;
    }

    const record = this.beginBuild({ name, provenance: "dockerfile" });
    // Persist the source so a later "rebuild" can replay it without the
    // caller resubmitting the text.
    this.store.update(name, { dockerfile });
    const run = this.executeBuild(
      record,
      { contextDir: context, dockerfile },
      cleanup,
    ).finally(() => {
      this.inflight.delete(name);
    });
    this.inflight.set(name, run);
    this.onBuildStarted?.(record.name, run);
    // Async (see buildSeed): return the `building` record immediately.
    return record;
  }

  // ── external (BYO reference) ──────────────────────────────────────────

  /** Register an externally-hosted image (e.g. GHCR) by reference — no
   * build, ready immediately. This is the already-working verbatim-ref
   * spawn path (`RuntimeService.resolveImage`); registering it here only
   * makes it visible/listable/deletable on the Images page. */
  registerExternal(name: string, ref: string): ImageRecord {
    assertValidName(name);
    const now = new Date().toISOString();
    const record: ImageRecord = {
      name,
      provenance: "external",
      status: "ready",
      ref,
      createdAt: this.store.get(name)?.createdAt ?? now,
      updatedAt: now,
    };
    this.store.put(record);
    log.info({ name, ref }, "external image registered");
    return record;
  }

  // ── delete ─────────────────────────────────────────────────────────────

  /** Refuses when a live sandbox or a stored snapshot still resolves its
   * boot image to this one — mirrors `RuntimeService.deletePrebuild`'s
   * `referencedSnapshotRefs` guard. Matches by the image's bare name (the
   * spec-facing form) or its full `${registryUrl}/${name}` ref (the
   * resolved form a snapshot row stores), so either shape references
   * correctly. */
  deleteImage(name: string): void {
    const record = this.store.get(name);
    if (!record) throw new NotFoundError("Image", name);
    if (record.status === "building") {
      throw new ValidationError(
        `Image '${name}' is still building and cannot be deleted; wait for ` +
          "the build to finish (or fail) first.",
      );
    }
    const qualified = this.qualify(name);
    const referenced = this.referencedImageRefs();
    const inUse = referenced.some(
      (ref) =>
        ref === name ||
        ref === qualified ||
        ref.startsWith(`${qualified}@`) ||
        ref.startsWith(`${qualified}:`),
    );
    if (inUse) {
      throw new ValidationError(
        `Image '${name}' is in use (a sandbox boots from it or a stored ` +
          "snapshot was built on it) and cannot be deleted.",
      );
    }
    this.store.delete(name);
  }

  // ── startup reconciliation ─────────────────────────────────────────────

  /** Sweep any row left `building` by a server restart (its in-flight
   * execution died with the process — nothing is polling it anymore) to
   * `error`, mirroring `RuntimeService.reconcileOnStartup`'s zombie sweep
   * for `creating` sandboxes. Synchronous: called once at boot before the
   * HTTP listener starts, same as the runtime's sweep. */
  reconcileOnStartup(): void {
    for (const record of this.store.list()) {
      if (record.status !== "building") continue;
      this.store.update(record.name, {
        status: "error",
        error: "Build interrupted by server restart.",
      });
      log.warn(
        { name: record.name },
        "swept image stuck in building (server restarted mid-build)",
      );
    }
  }

  // ── shared build execution ─────────────────────────────────────────────

  /** Prefix a name with the configured registry, or leave it bare when none is
   * set (local Docker mode). Mirrors `qualifyImageName` but reads through the
   * injected `registryUrl` dep so builds stay testable. */
  private qualify(name: string): string {
    const registry = this.registryUrl();
    return registry ? `${registry}/${name}` : name;
  }

  private beginBuild(fields: {
    name: string;
    provenance: ImageRecord["provenance"];
    seedId?: string;
  }): ImageRecord {
    const now = new Date().toISOString();
    const existing = this.store.get(fields.name);
    const record: ImageRecord = {
      name: fields.name,
      provenance: fields.provenance,
      status: "building",
      seedId: fields.seedId,
      buildLog: "",
      error: undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.store.put(record);
    return record;
  }

  private async executeBuild(
    record: ImageRecord,
    input: {
      contextDir: string;
      dockerfile: string;
      buildArgs?: Record<string, string>;
    },
    cleanup?: () => Promise<unknown>,
  ): Promise<ImageRecord> {
    // No configured registry => local Docker mode: bare tag, no push, and the
    // stored ref is the tag itself (a local-daemon reference).
    const local = !this.registryUrl();
    const tag = `${this.qualify(record.name)}:latest`;
    const controller = new AbortController();
    // Bound the backend call to BUILD_TIMEOUT_MS regardless of provenance:
    // the k8s builders (kaniko/buildkit) already self-bound via
    // `activeDeadlineSeconds`, but the docker backend has no such bound of
    // its own — a hung `docker build`/`push` against a wedged daemon would
    // otherwise wedge this build's `inflight` entry until a full server
    // restart (C1). `AbortSignal.any` combines this timeout with the
    // service's own controller so either source can abort the build.
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(BUILD_TIMEOUT_MS),
    ]);
    const lines: string[] = [];
    let lastFlush = 0;
    let pendingFlush: ReturnType<typeof setTimeout> | undefined;

    const flush = () => {
      pendingFlush = undefined;
      lastFlush = Date.now();
      this.store.update(record.name, {
        buildLog: lines.slice(-LOG_TAIL_LINES).join(""),
      });
    };
    const onLog = (chunk: string) => {
      lines.push(chunk);
      if (lines.length > LOG_TAIL_LINES * 2)
        lines.splice(0, lines.length - LOG_TAIL_LINES);
      if (Date.now() - lastFlush >= LOG_FLUSH_INTERVAL_MS && !pendingFlush) {
        pendingFlush = setTimeout(flush, 0);
      }
    };

    try {
      // Build-args carry no secrets here — the only caller-threaded arg is a
      // public image reference (`AGENT_IMAGE`), never a credential (mirrors
      // the prebuild path's discipline of injecting credentials transiently
      // via the agent, never baked/logged).
      const builderCfg = imageBuilderConfig();
      const { digest } = await this.builder().build(
        {
          contextDir: input.contextDir,
          dockerfile: input.dockerfile,
          tag,
          local,
          buildArgs: input.buildArgs,
          insecureRegistry: builderCfg.insecureRegistry,
          cacheRepo: builderCfg.cacheRepo || undefined,
        },
        onLog,
        signal,
      );
      if (pendingFlush) clearTimeout(pendingFlush);
      const ref = local ? tag : `${this.qualify(record.name)}@${digest}`;
      const updated = this.store.update(record.name, {
        status: "ready",
        digest,
        ref,
        buildLog: lines.slice(-LOG_TAIL_LINES).join(""),
        error: undefined,
      });
      log.info({ name: record.name, digest }, "image built and pushed");
      return updated ?? record;
    } catch (err) {
      if (pendingFlush) clearTimeout(pendingFlush);
      const message = err instanceof Error ? err.message : String(err);
      const updated = this.store.update(record.name, {
        status: "error",
        error: message,
        buildLog: lines.slice(-LOG_TAIL_LINES).join(""),
      });
      log.error({ name: record.name, err: message }, "image build failed");
      return updated ?? record;
    } finally {
      // Own the build context's lifetime here (not in the route): the
      // background build only completes after this method's caller has
      // already returned the `building` record to the client.
      if (cleanup) await cleanup().catch(() => {});
    }
  }
}
