/**
 * Prebuilds: content-addressed, chained workspace snapshots baked in a
 * throwaway pod (repos cloned, `build[]` run), plus the policy around them —
 * the recipe's runtime surface, staleness against git HEADs, retention and
 * the last-good fallback. Shares only the build-pod flow and the source
 * resolver with the toolset code.
 */
import { createHash } from "node:crypto";
import {
  canonicalJson,
  type PrebuildRecord,
  type PrebuildSpec,
  prebuildRecipeKey,
  type RuntimeSurface,
  runtimeSurfaceOf,
  type SnapshotRef,
  withoutSurface,
} from "@atelier/spec";
import {
  ForbiddenError,
  NotFoundError,
  SandboxError,
  ValidationError,
} from "../shared/errors.ts";
import {
  buildGitAttributionFiles,
  GIT_CREDENTIALS_PATH,
} from "../shared/lib/git-attribution.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { type AgentClient, toFileWrites } from "./agent/index.ts";
import type { SandboxBackend } from "./backend/index.ts";
import { type BuildPods, type OnLog, prebuildToSpec } from "./build-pod.ts";
import type { getRemoteCommitHash } from "./git-remote.ts";
import { shQuote } from "./registry/builder/builder.types.ts";
import { resourceName } from "./resource-name.ts";
import { referencedSnapshotRefs, removeSnapshot } from "./snapshot-helpers.ts";
import type { SourceResolver } from "./source-resolver.ts";
import type { SandboxStore, SnapshotRecord, SnapshotStore } from "./store.ts";

const log = createChildLogger("runtime-prebuild");

export interface PrebuildDeps {
  agent: AgentClient;
  backend: SandboxBackend;
  sandboxes: SandboxStore;
  snapshots: SnapshotStore;
  resolver: SourceResolver;
  buildPods: BuildPods;
  /** A repo's current remote HEAD (`git ls-remote`). Injectable so tests
   * key prebuilds without network git. */
  remoteHead: typeof getRemoteCommitHash;
}

export interface PrebuildOptions {
  force?: boolean;
  githubToken?: string;
  createdBy?: string;
  signal?: AbortSignal;
  onLog?: OnLog;
  saveSurface?: boolean;
  /** The caller is a server admin: may rewrite any recipe's surface (the
   * policy lives in api/, the runtime only enforces it). */
  surfaceAdmin?: boolean;
}

/** The user acting on a prebuild (editing its surface, reading its recipe):
 * an opaque user id, and whether they are a server admin. */
export interface SurfaceEditor {
  userId: string;
  admin: boolean;
}

/** A stored prebuild whose repos moved upstream: the recipe to bake again. */
interface StalePrebuild {
  /** The snapshot that went stale. */
  ref: string;
  /** The content key the rebuild will have. */
  hash: string;
  spec: PrebuildSpec;
  githubToken?: string;
  createdBy?: string;
}

/** A spawn's prebuild: the snapshot to boot from, plus a warning when it is
 * not the fresh build the spawn asked for. */
export type SpawnPrebuild = SnapshotRef & { warning?: string };

function hasSurface(surface: RuntimeSurface): boolean {
  return Boolean(surface.processes?.length || surface.ports?.length);
}

/** Lineage identity for a prebuild: the spec's shape independent of the
 * resolved git HEADs a build was keyed on. Two snapshots share a lineage when
 * they came from the same source/files/build/repos recipe — i.e. the same
 * prebuild followed across upstream pushes. `env` is excluded (build-time
 * credential material, never lineage-defining — same rationale as the content
 * key in `resolveContentKey`). */
function prebuildLineageKey(spec: PrebuildSpec): string {
  const keyed = {
    source: spec.source,
    files: spec.files ?? [],
    build: spec.build ?? [],
    repos: spec.repos ?? [],
  };
  return createHash("sha256").update(JSON.stringify(keyed)).digest("hex");
}

/** What stands in for a masked `env` value or file content. */
const REDACTED = "[redacted]";

function mayReadSecrets(
  snapshot: SnapshotRecord,
  viewer: SurfaceEditor,
): boolean {
  return viewer.admin || snapshot.createdBy === viewer.userId;
}

/** The recipe with its literal secrets masked: `env` values and file
 * contents. Keys, paths and everything else stay, so it still reads. */
function redactedSpec(
  spec: PrebuildSpec | undefined,
): PrebuildSpec | undefined {
  if (!spec) return spec;
  return {
    ...spec,
    ...(spec.env
      ? {
          env: Object.fromEntries(
            Object.keys(spec.env).map((key) => [key, REDACTED]),
          ),
        }
      : {}),
    ...(spec.files
      ? { files: spec.files.map((file) => ({ ...file, content: REDACTED })) }
      : {}),
  };
}

export class PrebuildService {
  private readonly agent: AgentClient;
  private readonly backend: SandboxBackend;
  private readonly sandboxes: SandboxStore;
  private readonly snapshots: SnapshotStore;
  private readonly resolver: SourceResolver;
  private readonly buildPods: BuildPods;
  private readonly remoteHead: typeof getRemoteCommitHash;
  /** De-dupes concurrent prebuild() calls for the same content hash onto one
   * execution (the temp pod name is deterministic and would collide). */
  private readonly inflight = new Map<string, Promise<SnapshotRef>>();

  constructor(deps: PrebuildDeps) {
    this.agent = deps.agent;
    this.backend = deps.backend;
    this.sandboxes = deps.sandboxes;
    this.snapshots = deps.snapshots;
    this.resolver = deps.resolver;
    this.buildPods = deps.buildPods;
    this.remoteHead = deps.remoteHead;
  }

  /**
   * Chained, content-addressed prebuild. Idempotent: keyed by content hash;
   * a hit returns instantly. The key includes the resolved base image and
   * each repo's current remote HEAD (`resolveContentKey`), so a base image
   * update or a git push busts the hash instead of silently reusing a stale
   * snapshot. When a repo's HEAD cannot be resolved (`git ls-remote` failed)
   * the key would silently match an older snapshot, so the call fails
   * instead of serving it. `options.force` bypasses the cache hit — used by
   * the console's explicit "rebuild" action and by the stale refresh.
   * Concurrent calls for the same hash dedupe onto one execution (the
   * deterministic temp pod name would otherwise collide).
   *
   * The runtime surface (`processes`/`ports`) is a setting of the *recipe*,
   * shared by all its snapshots (see `setSurface`), and only an explicit
   * save writes it: `saveSurface` (the `POST /prebuilds` create or rebuild),
   * or `setSurface`. Any other call (a spawn re-resolving an inline recipe,
   * the stale-prebuild refresh) never changes it, even when the call bakes:
   * the new snapshot inherits the recipe's dev servers. The one exception is
   * a recipe's very first bake, which has none to inherit: it records the
   * declared ones, so the snapshot lists what its first spawn ran.
   *
   * `createdBy` (an opaque user id, paired with that user's `githubToken`)
   * is recorded on the snapshot so the stale refresh can re-resolve a
   * private repo with the same user's token. A cache hit on a snapshot with
   * no recorded creator adopts the caller: their token just resolved every
   * repo HEAD (the hash would not match otherwise), so they can read them.
   */
  async prebuild(
    spec: PrebuildSpec,
    options: PrebuildOptions = {},
  ): Promise<SnapshotRef> {
    const { hash, image, snapshotName, repoHeads, unresolvedRepos } =
      await this.resolveContentKey(spec, options.githubToken);
    if (unresolvedRepos.length > 0) {
      throw new SandboxError(
        `Cannot resolve the current git HEAD of ${unresolvedRepos.join(", ")} ` +
          "(the remote is unreachable or the token cannot read it); refusing " +
          "to serve or bake a prebuild keyed on partial repo state.",
        "REPO_UNREACHABLE",
        502,
      );
    }
    const declared = runtimeSurfaceOf(spec);
    const save = options.saveSurface === true && hasSurface(declared);
    if (save) {
      this.assertMaySaveSurface(spec, declared, {
        userId: options.createdBy,
        admin: options.surfaceAdmin === true,
      });
    }
    if (!options.force) {
      const existing = this.snapshots.getByHash(hash);
      if (existing) {
        if (save) this.writeRecipeSurface(existing, declared);
        this.adoptCreator(existing, options);
        return { ref: existing.ref, hash, parent: existing.parent };
      }
    }
    // What the new snapshot records: a saved surface, else the recipe's
    // current one (its re-bakes and spawns never change it), else — the
    // recipe's first bake — whatever the caller declared.
    const known = this.recipeSnapshots(spec).length > 0;
    const surface = save || !known ? declared : this.recipeSurface(spec);
    const toBake: PrebuildSpec = { ...withoutSurface(spec), ...surface };
    // A save becomes the recipe's, on its older snapshots too — also when it
    // joins a bake another caller (a spawn) started.
    const saved = (snapshot: SnapshotRef): SnapshotRef => {
      const baked = this.snapshots.get(snapshot.ref);
      if (baked && save) this.writeRecipeSurface(baked, declared);
      return snapshot;
    };
    // A concurrent request for the same content shares the in-flight build
    // (and thus the first caller's cancellation) — cancel is best-effort, so
    // a later job deduped onto an existing run may not observe its own signal.
    const inflight = this.inflight.get(hash);
    if (inflight) return inflight.then(saved);
    const run = this.executePrebuild(toBake, hash, image, snapshotName, {
      githubToken: options.githubToken,
      createdBy: options.createdBy,
      signal: options.signal,
      onLog: options.onLog,
      repoHeads,
    })
      .then(saved)
      .finally(() => {
        this.inflight.delete(hash);
      });
    this.inflight.set(hash, run);
    return run;
  }

  /** A cache hit's snapshot with no recorded creator adopts the caller. */
  private adoptCreator(
    existing: SnapshotRecord,
    { createdBy, githubToken }: PrebuildOptions,
  ): void {
    if (existing.createdBy || !createdBy || !githubToken) return;
    this.snapshots.put({
      ...(this.snapshots.get(existing.ref) ?? existing),
      createdBy,
    });
  }

  /**
   * The stored snapshot a `prebuild` call would return without baking, or
   * undefined when it would have to bake (or fail): lets a spawn skip the job
   * queue entirely for the common cached case, so a quick spawn never waits
   * behind long builds.
   */
  async cached(
    spec: PrebuildSpec,
    options: PrebuildOptions = {},
  ): Promise<SnapshotRef | undefined> {
    const { hash, unresolvedRepos } = await this.resolveContentKey(
      spec,
      options.githubToken,
    );
    if (unresolvedRepos.length > 0) return undefined;
    const existing = this.snapshots.getByHash(hash);
    if (!existing) return undefined;
    this.adoptCreator(existing, options);
    return { ref: existing.ref, hash, parent: existing.parent };
  }

  /**
   * `prebuild` for a spawn, which would rather boot slightly stale than not
   * at all: when the fresh build fails (build error, unreachable git remote,
   * registry down) it falls back to the recipe's most recent successful
   * snapshot (an older HEAD) and says so in `warning`. A caller's mistake
   * (4xx: unknown source, forbidden) and a cancel still fail; so does a
   * recipe that was never baked.
   */
  async prebuildForSpawn(
    spec: PrebuildSpec,
    options: PrebuildOptions = {},
  ): Promise<SpawnPrebuild> {
    try {
      return await this.prebuild(spec, options);
    } catch (err) {
      if (options.signal?.aborted) throw err;
      if (err instanceof SandboxError && err.statusCode < 500) throw err;
      const [lastGood] = this.recipeSnapshots(spec);
      if (!lastGood) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(
        { ref: lastGood.ref, err },
        "prebuild failed; spawning from the last good one",
      );
      return {
        ref: lastGood.ref,
        hash: lastGood.hash,
        parent: lastGood.parent,
        warning:
          `The current prebuild could not be built (${reason.split("\n")[0]}); ` +
          `booted from the last good one, built ${lastGood.createdAt}.`,
      };
    }
  }

  /**
   * Set a stored prebuild's runtime surface (its dev servers, applied at
   * boot) without resolving or baking anything: the "save, no rebuild"
   * action. Applied to every snapshot of the same recipe, so a snapshot
   * re-baked after a push (a newer ref of the same recipe) gets it too.
   * An empty surface clears it.
   */
  setSurface(
    ref: string,
    surface: RuntimeSurface,
    editor: SurfaceEditor,
  ): PrebuildSpec {
    const record = this.prebuildRecord(ref);
    if (!record?.spec) throw new NotFoundError("Prebuild", ref);
    this.assertMaySaveSurface(record.spec, runtimeSurfaceOf(surface), editor);
    this.writeRecipeSurface(record, runtimeSurfaceOf(surface));
    return this.snapshots.get(ref)?.spec ?? record.spec;
  }

  /** The recipe a stored prebuild was baked from, or `undefined` for any
   * other snapshot (pause, manual) or an unknown ref. */
  specOf(ref: string): PrebuildSpec | undefined {
    return this.prebuildRecord(ref)?.spec;
  }

  /** The dev servers a sandbox booted from snapshot `ref` gets: its
   * recipe's current ones (`{}` for a pause/manual snapshot). */
  surfaceOf(ref: string): RuntimeSurface {
    const spec = this.prebuildRecord(ref)?.spec;
    return spec ? this.recipeSurface(spec) : {};
  }

  /** List stored prebuild snapshots, newest first — the read side of
   * `prebuild()`, for the console's prebuild list and one-tap spawn. Each
   * record is flagged `inUse` so the console can offer deletion of the stale,
   * unreferenced ones without risking a live boot source.
   *
   * With a `viewer`, a recipe's `env` values and file contents (build-time
   * credentials, stored in clear) are masked unless the viewer is a server
   * admin or the snapshot's creator. Without one, the list is complete: for
   * server-side callers that never hand it out. */
  list(viewer?: SurfaceEditor): PrebuildRecord[] {
    const referenced = referencedSnapshotRefs(this.sandboxes, this.snapshots);
    return this.prebuilds()
      .map((s) => ({
        ref: s.ref,
        hash: s.hash,
        image: s.image,
        parent: s.parent,
        metadata: s.metadata,
        spec:
          viewer && !mayReadSecrets(s, viewer) ? redactedSpec(s.spec) : s.spec,
        repoHeads: s.repoHeads,
        inUse: referenced.has(s.ref),
        createdAt: s.createdAt,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Delete a stored prebuild snapshot (VolumeSnapshot + record). Refuses when
   * the snapshot is still referenced by a sandbox or a chained prebuild. */
  async delete(ref: string): Promise<void> {
    if (!this.prebuildRecord(ref)) throw new NotFoundError("Prebuild", ref);
    if (referencedSnapshotRefs(this.sandboxes, this.snapshots).has(ref)) {
      throw new ValidationError(
        `Snapshot ${ref} is in use (a sandbox boots from it or a prebuild is ` +
          "chained on it) and cannot be deleted.",
      );
    }
    await removeSnapshot(this.backend, this.snapshots, ref);
  }

  /**
   * Scheduler entry: for every stored prebuild that clones repos, recompute
   * the content key (which reflects current remote HEADs + base image
   * digest) and return the recipes whose key moved and has no snapshot yet:
   * upstream moved, so they need a fresh bake. The caller dispatches the
   * rebuilds (through the job feed); a failed rebuild leaves the previous
   * snapshot in place. Superseded snapshots are NOT deleted here — retention
   * is `prune(keep)`.
   *
   * There is no caller here, so private repos are reached with the GitHub
   * token of the user who baked the prebuild (`createdBy`, looked up through
   * `githubTokenOf`, since runtime knows no users). A prebuild without a
   * recorded creator, or whose creator has no token, only resolves public
   * repos and so is skipped while any of its repos is private.
   */
  async findStale(
    githubTokenOf: (userId: string) => string | undefined = () => undefined,
  ): Promise<StalePrebuild[]> {
    const stale: StalePrebuild[] = [];
    const seen = new Set<string>();
    for (const snap of this.prebuilds()) {
      if (!snap.spec?.repos?.length) continue;
      try {
        const githubToken = snap.createdBy
          ? githubTokenOf(snap.createdBy)
          : undefined;
        const { hash, unresolvedRepos } = await this.resolveContentKey(
          snap.spec,
          githubToken,
        );
        // A transient ls-remote failure drops a repo from the key, which would
        // otherwise flap the hash and trigger a rebuild every tick. Only act on
        // drift we can trust — skip until every repo HEAD resolves.
        if (unresolvedRepos.length > 0) continue;
        if (hash === snap.hash || seen.has(hash)) continue;
        if (this.snapshots.getByHash(hash)) continue;
        seen.add(hash);
        stale.push({
          ref: snap.ref,
          hash,
          spec: snap.spec,
          githubToken,
          createdBy: snap.createdBy,
        });
      } catch (err) {
        log.error({ ref: snap.ref, err }, "prebuild staleness check failed");
      }
    }
    return stale;
  }

  /**
   * Retention for prebuild snapshots (config `prebuild.pruneKeep`). Groups
   * prebuilds by lineage (the same spec regardless of resolved git HEADs) and,
   * within each lineage, keeps the newest `keep` UNUSED snapshots — deleting
   * the rest. In-use snapshots (a sandbox boots from them, or a prebuild is
   * chained on them) are never counted or deleted, so pause/resume and live
   * boots are unaffected. The newest snapshot of a lineage always stays (even
   * with `keep = 0`): it is what a spawn resolves to, and a failed refresh
   * must not leave the recipe without a snapshot. Returns the number of
   * snapshots deleted.
   */
  async prune(keep: number): Promise<number> {
    const referenced = referencedSnapshotRefs(this.sandboxes, this.snapshots);
    const lineages = new Map<string, SnapshotRecord[]>();
    for (const snap of this.prebuilds()) {
      if (!snap.spec) continue;
      const key = prebuildLineageKey(snap.spec);
      const group = lineages.get(key);
      if (group) group.push(snap);
      else lineages.set(key, [snap]);
    }

    let deleted = 0;
    for (const group of lineages.values()) {
      const newest = group.reduce((a, b) =>
        a.createdAt >= b.createdAt ? a : b,
      );
      const unused = group
        .filter((s) => s.ref !== newest.ref && !referenced.has(s.ref))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      // `newest` counts as one kept snapshot when it is itself unused.
      const slots = referenced.has(newest.ref) ? keep : Math.max(keep - 1, 0);
      for (const stale of unused.slice(slots)) {
        try {
          await removeSnapshot(this.backend, this.snapshots, stale.ref);
          deleted++;
        } catch (err) {
          log.error({ ref: stale.ref, err }, "prebuild prune failed");
        }
      }
    }
    if (deleted > 0) log.info({ deleted, keep }, "pruned unused prebuilds");
    return deleted;
  }

  /** Real prebuilds only: the table also holds pause/manual/fork snapshots. */
  private prebuilds(): SnapshotRecord[] {
    return this.snapshots.list().filter((s) => s.kind === "prebuild");
  }

  private prebuildRecord(ref: string): SnapshotRecord | undefined {
    const record = this.snapshots.get(ref);
    return record?.kind === "prebuild" ? record : undefined;
  }

  /** The snapshots baked from the same recipe as `spec` (every re-bake
   * after a push is another one), newest first. */
  private recipeSnapshots(spec: PrebuildSpec): SnapshotRecord[] {
    const key = prebuildRecipeKey(spec);
    return this.prebuilds()
      .filter((s) => s.spec && prebuildRecipeKey(s.spec) === key)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * A recipe's dev servers run as commands inside every sandbox spawned from
   * it, so changing an existing recipe's surface is limited to a server admin
   * or the recipe's creator (the `createdBy` of its oldest snapshot: a
   * rebuild by someone else never makes them the creator). A recipe with no
   * snapshot yet (its first bake) or an unchanged surface needs no right.
   */
  private assertMaySaveSurface(
    spec: PrebuildSpec,
    wanted: RuntimeSurface,
    editor: { userId?: string; admin: boolean },
  ): void {
    const snapshots = this.recipeSnapshots(spec);
    if (snapshots.length === 0 || editor.admin) return;
    if (canonicalJson(wanted) === canonicalJson(this.recipeSurface(spec))) {
      return;
    }
    const creator = snapshots.at(-1)?.createdBy;
    if (creator !== undefined && creator === editor.userId) return;
    throw new ForbiddenError(
      "Only the prebuild's creator or a server admin can change its dev servers",
    );
  }

  /** The recipe's current dev servers: the newest of its snapshots' (they
   * agree unless written before surfaces were shared). */
  private recipeSurface(spec: PrebuildSpec): RuntimeSurface {
    const [newest] = this.recipeSnapshots(spec);
    return newest?.spec ? runtimeSurfaceOf(newest.spec) : {};
  }

  private writeRecipeSurface(
    record: SnapshotRecord,
    surface: RuntimeSurface,
  ): void {
    if (!record.spec) return;
    const want = canonicalJson(surface);
    for (const snap of this.recipeSnapshots(record.spec)) {
      if (!snap.spec) continue;
      if (canonicalJson(runtimeSurfaceOf(snap.spec)) === want) continue;
      const { processes: _p, ports: _q, ...baked } = snap.spec;
      this.snapshots.put({ ...snap, spec: { ...baked, ...surface } });
      log.info({ ref: snap.ref }, "prebuild processes/ports updated");
    }
  }

  /** Resolve the content key for a prebuild: source resolved to its current
   * image/snapshot, plus each repo's current remote HEAD. `env` is
   * intentionally excluded (docs/archive/design.md §2): it carries build-time secrets
   * (tokens) that must never enter a persisted content key, and is treated
   * as credential material rather than artifact-identifying input. */
  private async resolveContentKey(
    spec: PrebuildSpec,
    githubToken?: string,
  ): Promise<{
    hash: string;
    image: string;
    snapshotName?: string;
    repoHeads: Record<string, string>;
    /** Repos whose HEAD failed to resolve; a key built while any is
     * unresolved is partial (and flappy), so callers must not act on it. */
    unresolvedRepos: string[];
  }> {
    const { image, snapshotName } = await this.resolver.resolveSource(
      spec.source,
    );
    const { heads: repoHeads, unresolved } = await this.resolveRepoHeads(
      spec.repos,
      githubToken,
    );
    const keyed = {
      source: spec.source,
      image,
      files: spec.files ?? [],
      build: spec.build ?? [],
      repos: spec.repos ?? [],
      repoHeads,
    };
    const hash = createHash("sha256")
      .update(JSON.stringify(keyed))
      .digest("hex");
    return {
      hash,
      image,
      snapshotName,
      repoHeads,
      unresolvedRepos: unresolved,
    };
  }

  /** Current remote HEAD per repo (keyed by `clonePath`), so a git push busts
   * the content key. Resolved in parallel; `unresolved` lists the repo URLs
   * whose HEAD failed. */
  private async resolveRepoHeads(
    repos: PrebuildSpec["repos"],
    githubToken?: string,
  ): Promise<{ heads: Record<string, string>; unresolved: string[] }> {
    if (!repos?.length) return { heads: {}, unresolved: [] };
    const resolved = await Promise.all(
      repos.map(async (repo) => ({
        repo,
        head: await this.remoteHead(repo.url, repo.branch, githubToken),
      })),
    );
    const heads: Record<string, string> = {};
    const unresolved: string[] = [];
    for (const { repo, head } of resolved) {
      if (head) heads[repo.clonePath] = head;
      else unresolved.push(repo.url);
    }
    return { heads, unresolved };
  }

  private async executePrebuild(
    spec: PrebuildSpec,
    hash: string,
    image: string,
    snapshotName: string | undefined,
    {
      githubToken,
      createdBy,
      signal,
      onLog,
      repoHeads,
    }: {
      githubToken?: string;
      createdBy?: string;
      signal?: AbortSignal;
      onLog?: OnLog;
      repoHeads: Record<string, string>;
    },
  ): Promise<SnapshotRef> {
    const parentRef =
      "snapshot" in spec.source ? spec.source.snapshot : undefined;
    const ref = `snap-${hash.slice(0, 12)}`;
    const tempId = `pb-${hash.slice(0, 12)}`;

    // Boot a throwaway pod (from the image or the parent snapshot — chaining
    // falls out of the source resolver) to bake files/repos/build[] into a
    // fresh PVC, snapshot it, then tear the pod + PVC down. The snapshot
    // outlives the pod. The prebuild pod runs NO processes (the synthesized
    // spec has none), so boot just stages files + pushes env for the build
    // steps.
    return this.buildPods.withThrowawayPod(
      tempId,
      prebuildToSpec(spec),
      { image, snapshotName },
      "prebuild pod cleanup failed",
      async () => {
        // Inject the git credential transiently — via the agent, NOT the boot
        // spec's files[] — so the token neither enters the content hash nor is
        // baked into the snapshot. Written before clone/build so private repos
        // authenticate through the `store` credential helper.
        if (githubToken) {
          await this.agent.writeFiles(
            tempId,
            toFileWrites(buildGitAttributionFiles({ githubToken })),
          );
        }
        await this.runSteps(tempId, spec, signal, onLog);
        // Bail before the (irreversible) snapshot if canceled during the build.
        signal?.throwIfAborted();
        onLog?.("Snapshotting workspace…");
        // Scrub the credential before snapshotting: the snapshot is a shared,
        // content-addressed artifact that must never carry a user's token.
        // (The file lives on the pod's ephemeral rootfs, outside the `/home/dev`
        // PVC the snapshot captures — this is explicit defense-in-depth.)
        if (githubToken) {
          await this.agent
            .exec(tempId, `rm -f ${GIT_CREDENTIALS_PATH}`, { user: "root" })
            .catch((err) =>
              log.warn({ tempId, err }, "git credential scrub failed"),
            );
        }
        // Flush the guest filesystem before snapshotting. The workspace is a
        // raw block device the Kata guest formats + mounts ext4, so a build
        // step's writes (e.g. `git clone`'s objects/refs/checkout) can still
        // sit in the guest page cache after the step returns exit 0. The CSI
        // VolumeSnapshot captures the underlying block device, so without this
        // `sync` it can snapshot a torn filesystem — the classic symptom being
        // a baked repo with only a partial `.git` (leftover `shallow.lock`,
        // empty `HEAD`, no working tree) and no files. Mirrors the pre-pause
        // sync; awaited so the flush completes before the snapshot is taken.
        await this.agent
          .exec(tempId, "sync", { user: "root", timeout: 30_000 })
          .catch((err) =>
            log.warn({ tempId, err }, "pre-snapshot sync failed"),
          );
        // The content hash is 64 hex chars — over the 63-byte k8s label cap — so
        // it rides as an annotation (no length cap), not a label.
        await this.backend.volumes.snapshot(
          resourceName(tempId),
          ref,
          { "atelier.dev/component": "prebuild" },
          { "atelier.dev/prebuild": hash },
        );
        // Record as soon as the snapshot is ReadyToUse — before teardown — so a
        // failing cleanup can neither orphan a live-but-untracked snapshot nor
        // mask this success.
        this.snapshots.put({
          hash,
          kind: "prebuild",
          ref,
          image,
          parent: parentRef,
          metadata: spec.metadata,
          spec,
          repoHeads,
          createdBy,
          createdAt: new Date().toISOString(),
        });
        log.info({ ref, hash, parent: parentRef }, "prebuild snapshot created");
        return { ref, hash, parent: parentRef };
      },
    );
  }

  /** Clone repos then run build[] in the prebuild pod, fail-fast. The prebuild
   * `env` rides the pod env (pushed at boot), so build steps inherit it under
   * `/bin/bash -l`. */
  private async runSteps(
    tempId: string,
    spec: PrebuildSpec,
    signal?: AbortSignal,
    onLog?: OnLog,
  ): Promise<void> {
    for (const repo of spec.repos ?? []) {
      signal?.throwIfAborted();
      const branch = repo.branch ? `-b ${shQuote(repo.branch)} ` : "";
      // Clone as `dev` (uid 1000): clonePath lives on the /home/dev PVC the
      // snapshot captures, so the repo must be dev-owned. Cloning as root (the
      // default exec user) leaves the baked repo root-owned, which trips git's
      // "dubious ownership" guard and denies writes when dev boots the sandbox.
      await this.buildPods.execStep(
        tempId,
        `git clone --depth 1 ${branch}${shQuote(repo.url)} ${shQuote(repo.clonePath)}`,
        "dev",
        signal,
        onLog,
      );
    }
    // Build steps also run as `dev`: they operate inside the dev-owned
    // workspace/home the snapshot captures, so running them as root would bake
    // root-owned artifacts (e.g. node_modules) that dev can't write. A step
    // needing root uses `sudo` (same convention as the guest agent's hooks).
    for (const step of spec.build ?? []) {
      signal?.throwIfAborted();
      await this.buildPods.execStep(tempId, step, "dev", signal, onLog);
    }
  }
}
