/**
 * `RuntimeService` — THE SEAM. `runtime.create(spec)` as a function signature
 * that policy code cannot reach past (atelier-v2 §3). Mechanism only: it knows
 * how to boot/pause/resume/destroy, push files/env, supervise processes,
 * expose ports, run hooks, exec, and snapshot. It never parses ACP, reads a
 * harness config, or models "MCP". It imports nothing from control/ or
 * sessions/.
 */
import { createHash } from "node:crypto";
import {
  type AddPortRequest,
  type AddProcessRequest,
  type CreateSandboxResponse,
  type ExecRequest,
  isSecretRef,
  type PatchEnvRequest,
  type PatchFilesRequest,
  type PortEntry,
  type PrebuildRecord,
  type PrebuildSpec,
  type ProcessStatus,
  type ResumeRequest,
  type SandboxSpec,
  type SandboxState,
  type SandboxSummary,
  type SnapshotRef,
  type ToolsetBuildRequest,
  type ToolsetCaptureRequest,
  type ToolsetEntry,
  type ToolsetRef,
} from "@atelier/spec";
import {
  ConflictError,
  NotFoundError,
  SandboxError,
  ValidationError,
} from "../shared/errors.ts";
import { config, isMock } from "../shared/lib/config.ts";
import {
  buildGitAttributionFiles,
  GIT_CREDENTIALS_PATH,
} from "../shared/lib/git-attribution.ts";
import { safeNanoid } from "../shared/lib/id.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { HookPhase } from "./agent/index.ts";
import { AgentClient, toFileWrites } from "./agent/index.ts";
import { specToAgentConfig } from "./agent-config.ts";
import { createSandboxBackend, type SandboxBackend } from "./backend/index.ts";
import type { BootOutput } from "./boot.ts";
import { getRemoteCommitHash } from "./git-remote.ts";
import { gatingProcessNames } from "./ports.ts";
import {
  ImageNotAvailableError,
  ImageRegistryService,
  RegistryUnreachableError,
} from "./registry/index.ts";
import {
  type ImageStore,
  InMemoryImageStore,
  InMemorySandboxStore,
  InMemorySandboxToolsetRefStore,
  InMemorySnapshotStore,
  InMemoryToolsetStore,
  type SandboxRecord,
  type SandboxStore,
  type SandboxToolsetRefStore,
  type SnapshotRecord,
  type SnapshotStore,
  type ToolsetRecord,
  type ToolsetStore,
} from "./store.ts";

const log = createChildLogger("runtime");

/** Optional sink for a long op's live output (wired to the job log by the
 * api/ seam — see `JobService.dispatch`). Kept as a plain callback so the
 * runtime never depends on the jobs layer. */
type OnLog = (chunk: string) => void;

export interface RuntimeCreateOptions {
  /** Externally-chosen sandbox id (control assigns it). Defaults to a nanoid. */
  id?: string;
  /** SSH public keys authorized on the pipe — content resolved by the caller. */
  authorizedKeys?: string[];
}

export interface RuntimeDeps {
  agent?: AgentClient;
  /** The sandbox orchestration + storage backend. Defaults to the Kubernetes/
   * CSI backend; injectable so a Docker/local backend (or a test double) can
   * replace it without touching RuntimeService's policy. */
  backend?: SandboxBackend;
  sandboxes?: SandboxStore;
  snapshots?: SnapshotStore;
  toolsets?: ToolsetStore;
  sandboxToolsetRefs?: SandboxToolsetRefStore;
  /** Read-only view of the `images` table (shared with `ImageBuilderService`)
   * so `resolveImage` can prefer a built image's already-pinned digest over
   * re-resolving `:latest` on every spawn. */
  images?: ImageStore;
}

export class RuntimeService {
  private readonly agent: AgentClient;
  private readonly backend: SandboxBackend;
  private readonly sandboxes: SandboxStore;
  private readonly snapshots: SnapshotStore;
  private readonly toolsets: ToolsetStore;
  private readonly sandboxToolsetRefs: SandboxToolsetRefStore;
  private readonly images: ImageStore;
  /** De-dupes concurrent prebuild() calls for the same content hash onto one
   * execution (the temp pod name is deterministic and would collide). */
  private readonly inflightPrebuilds = new Map<string, Promise<SnapshotRef>>();
  /** De-dupes concurrent built-toolset executions by content hash (the temp
   * pod name is deterministic and would otherwise collide). */
  private readonly inflightToolsetBuilds = new Map<
    string,
    Promise<ToolsetRef>
  >();
  /** Per-sandbox operation lock: create/pause/resume/destroy/snapshot on the
   * same id serialize instead of racing (double resume booting two pods on
   * one pod name, destroy sweeping resources out from under an in-flight
   * create, …). Queued ops re-read the record once they acquire the lock, so
   * status guards see the previous op's outcome. */
  private readonly opLocks = new Map<string, Promise<void>>();

  constructor(deps: RuntimeDeps = {}) {
    // Backend before agent: the agent dials the backend's resolved endpoint
    // (pod IP on k8s, mapped host ports on Docker), so it must be wired to the
    // active backend's resolveAgentEndpoint.
    this.backend = deps.backend ?? createSandboxBackend();
    this.agent =
      deps.agent ??
      new AgentClient((id) => this.backend.resolveAgentEndpoint(id));
    this.sandboxes = deps.sandboxes ?? new InMemorySandboxStore();
    this.snapshots = deps.snapshots ?? new InMemorySnapshotStore();
    this.toolsets = deps.toolsets ?? new InMemoryToolsetStore();
    this.sandboxToolsetRefs =
      deps.sandboxToolsetRefs ?? new InMemorySandboxToolsetRefStore();
    this.images = deps.images ?? new InMemoryImageStore();
  }

  // ── prebuild ───────────────────────────────────────────────────────────

  /**
   * Chained, content-addressed prebuild. Idempotent: keyed by content hash;
   * a hit returns instantly. The key includes the resolved base image and
   * each repo's current remote HEAD (`resolveContentKey`), so a base image
   * update or a git push busts the hash instead of silently reusing a stale
   * snapshot. `options.force` bypasses the cache hit — used by the console's
   * explicit "rebuild" action and by `refreshStalePrebuilds`. Concurrent
   * calls for the same hash dedupe onto one execution (deterministic temp pod
   * name would otherwise collide).
   */
  async prebuild(
    spec: PrebuildSpec,
    options: {
      force?: boolean;
      githubToken?: string;
      signal?: AbortSignal;
      onLog?: OnLog;
    } = {},
  ): Promise<SnapshotRef> {
    const { hash, image, snapshotName } = await this.resolveContentKey(spec);
    if (!options.force) {
      const existing = this.snapshots.getByHash(hash);
      if (existing) {
        return { ref: existing.ref, hash, parent: existing.parent };
      }
    }
    // A concurrent request for the same content shares the in-flight build
    // (and thus the first caller's cancellation) — cancel is best-effort, so
    // a later job deduped onto an existing run may not observe its own signal.
    const inflight = this.inflightPrebuilds.get(hash);
    if (inflight) return inflight;
    const run = this.executePrebuild(
      spec,
      hash,
      image,
      snapshotName,
      options.githubToken,
      options.signal,
      options.onLog,
    ).finally(() => {
      this.inflightPrebuilds.delete(hash);
    });
    this.inflightPrebuilds.set(hash, run);
    return run;
  }

  /** List stored prebuild snapshots, newest first — the read side of
   * `prebuild()`, for the console's prebuild list and one-tap spawn. Each
   * record is flagged `inUse` so the console can offer deletion of the stale,
   * unreferenced ones without risking a live boot source. */
  listPrebuilds(): PrebuildRecord[] {
    const referenced = this.referencedSnapshotRefs();
    return (
      this.snapshots
        .list()
        // Only real prebuilds: the table also holds pause/manual snapshots
        // (no `spec`), which must never surface here as deletable prebuilds.
        .filter((s) => s.spec !== undefined)
        .map((s) => ({
          ref: s.ref,
          hash: s.hash,
          image: s.image,
          parent: s.parent,
          metadata: s.metadata,
          spec: s.spec,
          inUse: referenced.has(s.ref),
          createdAt: s.createdAt,
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    );
  }

  /** Refs that must not be deleted: a sandbox boots from them
   * (`source.snapshot`) or another snapshot is chained on them (`parent`). */
  private referencedSnapshotRefs(): Set<string> {
    const refs = new Set<string>();
    for (const s of this.sandboxes.list()) {
      if ("snapshot" in s.spec.source) refs.add(s.spec.source.snapshot);
    }
    for (const snap of this.snapshots.list()) {
      if (snap.parent) refs.add(snap.parent);
    }
    return refs;
  }

  /** Every image reference a live sandbox's `source.image` or a stored
   * snapshot's `image` still points at — the read `ImageBuilderService`'s
   * delete guard consumes (mirrors `referencedSnapshotRefs`, but across the
   * runtime/registry module seam so it stays a plain read, no shared
   * mutable state). */
  referencedImageRefs(): string[] {
    const refs: string[] = [];
    for (const s of this.sandboxes.list()) {
      if ("image" in s.spec.source) refs.push(s.spec.source.image);
    }
    for (const snap of this.snapshots.list()) {
      refs.push(snap.image);
    }
    return refs;
  }

  /** Delete a stored prebuild snapshot (VolumeSnapshot + record). Refuses when
   * the snapshot is still referenced by a sandbox or a chained prebuild. */
  async deletePrebuild(ref: string): Promise<void> {
    // Only prebuild snapshots (`spec`-bearing) are deletable here — a
    // pause/manual snapshot shares the table but is a sandbox's own storage,
    // and referencedSnapshotRefs() can't see a pause ref (it isn't in
    // `source.snapshot`), so treat those as not-a-prebuild.
    if (!this.snapshots.get(ref)?.spec)
      throw new NotFoundError("Prebuild", ref);
    if (this.referencedSnapshotRefs().has(ref)) {
      throw new ValidationError(
        `Snapshot ${ref} is in use (a sandbox boots from it or a prebuild is ` +
          "chained on it) and cannot be deleted.",
      );
    }
    await this.removeSnapshot(ref);
  }

  /** Drop a snapshot's VolumeSnapshot then its record. The k8s delete is
   * best-effort (an already-gone object must still clear the row) — matching
   * the runtime's cleanup style elsewhere. */
  private async removeSnapshot(ref: string): Promise<void> {
    await this.backend.volumes.deleteSnapshot(ref);
    this.snapshots.delete(ref);
    log.info({ ref }, "snapshot deleted");
  }

  /** Cron entry: for every stored prebuild that clones repos, recompute the
   * content key (which now reflects current remote HEADs + base image
   * digest). A changed key means upstream moved — rebuild to a fresh
   * snapshot. A key that already resolves to an existing snapshot is skipped
   * (already refreshed). Superseded snapshots are NOT deleted here — the
   * caller enforces retention separately via `pruneUnusedPrebuilds(keep)`, so
   * a configurable history of older versions survives a drift rebuild. */
  async refreshStalePrebuilds(): Promise<void> {
    for (const snap of this.snapshots.list()) {
      if (!snap.spec?.repos?.length) continue;
      try {
        const { hash, repoHeadsComplete } = await this.resolveContentKey(
          snap.spec,
        );
        // A transient ls-remote failure drops a repo from the key, which would
        // otherwise flap the hash and trigger a rebuild every tick. Only act on
        // drift we can trust — skip until every repo HEAD resolves.
        if (!repoHeadsComplete) continue;
        if (hash === snap.hash) continue;
        if (this.snapshots.getByHash(hash)) continue;
        log.info(
          { ref: snap.ref, oldHash: snap.hash, newHash: hash },
          "prebuild stale, rebuilding",
        );
        await this.prebuild(snap.spec);
      } catch (err) {
        log.error({ ref: snap.ref, err }, "prebuild staleness check failed");
      }
    }
  }

  /**
   * Retention for prebuild snapshots (config `prebuild.pruneKeep`). Groups
   * prebuilds by lineage (the same spec regardless of resolved git HEADs) and,
   * within each lineage, keeps the newest `keep` UNUSED snapshots — deleting
   * the rest. In-use snapshots (a sandbox boots from them, or a prebuild is
   * chained on them) are never counted or deleted, so pause/resume and live
   * boots are unaffected. `keep = 0` prunes every unused snapshot; `keep = 3`
   * keeps the last three. Returns the number of snapshots deleted.
   */
  async pruneUnusedPrebuilds(keep: number): Promise<number> {
    const referenced = this.referencedSnapshotRefs();
    const lineages = new Map<string, SnapshotRecord[]>();
    for (const snap of this.snapshots.list()) {
      if (!snap.spec) continue; // only real prebuilds (not pause/manual)
      const key = prebuildLineageKey(snap.spec);
      const group = lineages.get(key);
      if (group) group.push(snap);
      else lineages.set(key, [snap]);
    }

    let deleted = 0;
    for (const group of lineages.values()) {
      const unused = group
        .filter((s) => !referenced.has(s.ref))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      for (const stale of unused.slice(keep)) {
        try {
          await this.removeSnapshot(stale.ref);
          deleted++;
        } catch (err) {
          log.error({ ref: stale.ref, err }, "prebuild prune failed");
        }
      }
    }
    if (deleted > 0) log.info({ deleted, keep }, "pruned unused prebuilds");
    return deleted;
  }

  /** Resolve the content key for a prebuild: source resolved to its current
   * image/snapshot, plus each repo's current remote HEAD. `env` is
   * intentionally excluded (atelier-v2 §2): it carries build-time secrets
   * (tokens) that must never enter a persisted content key, and is treated
   * as credential material rather than artifact-identifying input. */
  private async resolveContentKey(spec: PrebuildSpec): Promise<{
    hash: string;
    image: string;
    snapshotName?: string;
    repoHeadsComplete: boolean;
  }> {
    const { image, snapshotName } = await this.resolveSource(spec.source);
    const { heads: repoHeads, complete: repoHeadsComplete } =
      await this.resolveRepoHeads(spec.repos);
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
    return { hash, image, snapshotName, repoHeadsComplete };
  }

  /** Current remote HEAD per repo (keyed by `clonePath`), so a git push busts
   * the content key. Resolved in parallel; skipped in mock mode (no network
   * git). `complete` is false when any HEAD failed to resolve, so callers can
   * avoid acting on a partial (and therefore flappy) key. */
  private async resolveRepoHeads(
    repos: PrebuildSpec["repos"],
  ): Promise<{ heads: Record<string, string>; complete: boolean }> {
    if (!repos?.length || isMock()) return { heads: {}, complete: true };
    const resolved = await Promise.all(
      repos.map(async (repo) => ({
        clonePath: repo.clonePath,
        head: await getRemoteCommitHash(repo.url, repo.branch),
      })),
    );
    const heads: Record<string, string> = {};
    let complete = true;
    for (const { clonePath, head } of resolved) {
      if (head) heads[clonePath] = head;
      else complete = false;
    }
    return { heads, complete };
  }

  private async executePrebuild(
    spec: PrebuildSpec,
    hash: string,
    image: string,
    snapshotName?: string,
    githubToken?: string,
    signal?: AbortSignal,
    onLog?: OnLog,
  ): Promise<SnapshotRef> {
    const parentRef =
      "snapshot" in spec.source ? spec.source.snapshot : undefined;
    const ref = `snap-${hash.slice(0, 12)}`;
    const tempId = `pb-${hash.slice(0, 12)}`;

    // Boot a throwaway pod (from the image or the parent snapshot — chaining
    // falls out of resolveSource) to bake files/repos/build[] into a fresh
    // PVC, snapshot it, then tear the pod + PVC down. The snapshot outlives
    // the pod. The prebuild pod runs NO processes (the synthesized spec has
    // none), so boot just stages files + pushes env for the build steps.
    return this.withThrowawayPod(
      tempId,
      prebuildToSpec(spec),
      { image, snapshotName },
      "prebuild pod cleanup failed",
      async (boot) => {
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
        await this.runPrebuildSteps(tempId, spec, signal, onLog);
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
        // The content hash is 64 hex chars — over the 63-byte k8s label cap — so
        // it rides as an annotation (no length cap), not a label.
        await this.snapshotPvc(
          boot.pvcName,
          ref,
          { "atelier.dev/component": "prebuild" },
          { "atelier.dev/prebuild": hash },
        );
        // Record as soon as the snapshot is ReadyToUse — before teardown — so a
        // failing cleanup can neither orphan a live-but-untracked snapshot nor
        // mask this success.
        this.snapshots.put({
          hash,
          ref,
          image,
          parent: parentRef,
          metadata: spec.metadata,
          spec,
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
  private async runPrebuildSteps(
    tempId: string,
    spec: PrebuildSpec,
    signal?: AbortSignal,
    onLog?: OnLog,
  ): Promise<void> {
    for (const repo of spec.repos ?? []) {
      signal?.throwIfAborted();
      const branch = repo.branch ? `-b ${shellQuote(repo.branch)} ` : "";
      // Clone as `dev` (uid 1000): clonePath lives on the /home/dev PVC the
      // snapshot captures, so the repo must be dev-owned. Cloning as root (the
      // default exec user) leaves the baked repo root-owned, which trips git's
      // "dubious ownership" guard and denies writes when dev boots the sandbox.
      await this.execStep(
        tempId,
        `git clone --depth 1 ${branch}${shellQuote(repo.url)} ${shellQuote(repo.clonePath)}`,
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
      await this.execStep(tempId, step, "dev", signal, onLog);
    }
  }

  private async execStep(
    tempId: string,
    command: string,
    user?: "dev" | "root",
    signal?: AbortSignal,
    onLog?: OnLog,
  ): Promise<void> {
    onLog?.(`$ ${command}`);
    const res = await this.agent.exec(tempId, command, {
      timeout: 600_000,
      user,
      signal,
    });
    if (res.stdout.trim()) onLog?.(res.stdout.trimEnd());
    if (res.stderr.trim()) onLog?.(res.stderr.trimEnd());
    if (res.exitCode !== 0) {
      onLog?.(`✗ exit ${res.exitCode}`);
      throw new Error(
        `build step failed (exit ${res.exitCode}): ${command}\n${res.stderr.trim()}`,
      );
    }
  }

  // ── create ─────────────────────────────────────────────────────────────

  async create(
    spec: SandboxSpec,
    options: RuntimeCreateOptions = {},
  ): Promise<CreateSandboxResponse> {
    rejectUnresolvedSecrets(spec);
    rejectDuplicateToolsetRefs(spec);
    const id = options.id ?? safeNanoid();
    return this.withOpLock(id, () => this.executeCreate(id, spec, options));
  }

  private async executeCreate(
    id: string,
    spec: SandboxSpec,
    options: RuntimeCreateOptions,
  ): Promise<CreateSandboxResponse> {
    if (this.sandboxes.get(id)) {
      throw new ConflictError(`Sandbox ${id} already exists`);
    }
    const { image, snapshotName } = await this.resolveSource(spec.source);

    const now = new Date().toISOString();
    const record: SandboxRecord = {
      id,
      spec,
      status: "creating",
      generated: {},
      metadata: spec.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.sandboxes.create(record);

    const toolsets = this.resolveSpecToolsets(spec);
    try {
      // bootSandbox pushes config + writes files[]. The fixed phase order
      // (atelier-v2 §6): files/env -> postCreate -> processes -> postStart.
      const boot = await this.backend.boot(
        id,
        spec,
        {
          image,
          snapshotName,
          authorizedKeys: options.authorizedKeys,
          toolsets,
        },
        this.agent,
      );
      // Persist which toolsets this sandbox mounted (toolset-overlay-squashfs
      // .md §6-7) as soon as boot (⇒ materialize ⇒ mounted) succeeds — NOT
      // after postStart — so a concurrent deleteToolset can't slip past the GC
      // guard during the (possibly minutes-long) hook/process phase. Resume
      // re-mounts from this list without re-resolving spec.toolsets. Stored as
      // host-relative refs (matching `ToolsetRecord.ref` / `deleteToolset`'s
      // param), not the full pull refs `toolsets` (above) carries for the
      // agent.
      this.sandboxToolsetRefs.putForSandbox(id, toRefEntries(spec.toolsets));

      await this.runPhase(id, "postCreate");
      await this.agent.reconcile(id);
      await this.gateOnPrimary(id);
      await this.runPhase(id, "postStart");

      this.sandboxes.update(id, {
        status: "running",
        podName: boot.podName,
        pvcName: boot.pvcName,
        generated: { agentPassword: boot.agentPassword, podIp: boot.podIp },
      });

      return {
        id,
        urls: await this.urlsFor(id, spec),
        generated: { agentPassword: boot.agentPassword, podIp: boot.podIp },
      };
    } catch (error) {
      // A failure in a post-boot phase (hooks/reconcile/primary gate) would
      // otherwise orphan the running pod; tear it down so the boot is atomic
      // (bootSandbox already cleans up failures during its own phase).
      this.agent.invalidatePodIp(id);
      await this.backend.cleanup(id);
      this.sandboxes.update(id, { status: "error" });
      throw error;
    }
  }

  // ── read ───────────────────────────────────────────────────────────────

  async get(id: string): Promise<SandboxState> {
    const record = this.require(id);
    const processes = await this.processStatuses(record);
    return {
      id,
      status: record.status,
      urls: await this.urlsFor(id, record.spec, processes),
      processes,
      generated: record.generated,
      metadata: record.metadata,
      annotations: record.spec.annotations,
    };
  }

  /** All sandboxes, from persistence only (no agent round-trips). Live
   * process health is on `get(id)`. */
  list(): SandboxSummary[] {
    return this.sandboxes.list().map((r) => ({
      id: r.id,
      status: r.status,
      createdAt: r.createdAt,
      annotations: r.spec.annotations,
    }));
  }

  // ── pause / resume ─────────────────────────────────────────────────────

  /** Snapshot the disk, release compute (delete pod, keep PVC). The snapshot
   * ref persists on the record: it is `resume()`'s boot source if the PVC is
   * ever lost (a failed resume boot cleans the PVC; the snapshot survives). */
  async pause(id: string): Promise<SnapshotRef> {
    return this.withOpLock(id, async () => {
      const record = this.require(id);
      if (record.status !== "running") {
        throw new ConflictError(
          `Sandbox ${id} is ${record.status}; only a running sandbox can be paused`,
        );
      }
      // Flush filesystem buffers before snapshotting — processes keep running
      // (the snapshot stays crash-consistent, not clean), but a sync bounds
      // the loss window for in-flight writes. Best-effort: an unreachable
      // agent must not block a pause (the pod is about to be deleted anyway).
      await this.agent
        .exec(id, "sync", { user: "root", timeout: 30_000 })
        .catch((err) => log.warn({ id, err }, "pre-pause sync failed"));
      const ref = await this.executeSnapshot(record);
      this.agent.invalidatePodIp(id);
      await this.backend.deleteRestartable(id);
      this.sandboxes.update(id, {
        status: "paused",
        pauseSnapshotRef: ref.ref,
      });
      log.info({ id, ref: ref.ref }, "sandbox paused");
      return ref;
    });
  }

  /** Boot from the paused disk, injecting rotated files/env, run onResume.
   * Boot source, in order: the PVC `pause()` left behind (the live disk —
   * reused, not cloned), else a clone from the persisted pause snapshot,
   * else the original `spec.source` (records that predate the pause, or an
   * `error` record recovering from scratch). Also the recovery route for
   * `status: "error"` records — a failed create/resume can be retried here.
   *
   * Toolsets are materialized on EVERY boot, including resume
   * (toolset-overlay-squashfs.md §6) — not skipped as under the old
   * extract-into-PVC model. Materialize is now mount-only and idempotent: the
   * squashfs blobs already live under `/data/toolsets` on the resumed PVC, so
   * this degrades to loop-mount + overlay re-assembly, no re-pull, no
   * clobber (edits live in `/data/upper`, untouched by re-mounting the RO
   * lowers). */
  async resume(id: string, req: ResumeRequest = {}): Promise<SandboxState> {
    await this.withOpLock(id, async () => {
      const record = this.require(id);
      if (record.status !== "paused" && record.status !== "error") {
        throw new ConflictError(
          `Sandbox ${id} is ${record.status}; only a paused or errored sandbox can be resumed`,
        );
      }
      const spec = mergeResume(record.spec, req);
      rejectUnresolvedSecrets(spec);
      const { image, snapshotName: sourceSnapshot } = await this.resolveSource(
        spec.source,
      );
      const reusePvc = await this.backend.volumes.volumeExists(
        record.pvcName ?? `sandbox-${id}`,
      );
      const toolsets = this.resolveSpecToolsets(spec);

      // Resume phase order: files/env -> onResume -> processes. onResume is
      // the credential-rotation primitive; it runs before processes restart.
      const boot = await this.backend.boot(
        id,
        spec,
        {
          image,
          reusePvc,
          // A resume boot failure must not sweep the paused disk/snapshot
          // (both carry the sandbox label); a retry needs them.
          preserveDisk: true,
          snapshotName: reusePvc
            ? undefined
            : (record.pauseSnapshotRef ?? sourceSnapshot),
          toolsets,
        },
        this.agent,
      );
      // Refresh the mounted-refs list to match this boot's resolved spec (a
      // resume can carry a rotated/updated `spec.toolsets` via `req`) as soon
      // as boot (⇒ materialize ⇒ mounted) succeeds — before the hook/process
      // phase, so the GC guard reflects the live mounts. Same host-relative-
      // ref form as create — see the comment there.
      this.sandboxToolsetRefs.putForSandbox(id, toRefEntries(spec.toolsets));
      try {
        await this.runPhase(id, "onResume");
        await this.agent.reconcile(id);
        await this.gateOnPrimary(id);
      } catch (error) {
        // Tear down the half-resumed pod (keep the PVC) and restore the prior
        // status so a retry starts clean (the pod name is fixed per sandbox; a
        // second boot would collide).
        this.agent.invalidatePodIp(id);
        await this.backend.deleteRestartable(id);
        this.sandboxes.update(id, { status: record.status });
        throw error;
      }
      // The disk is live again — the pause snapshot no longer reflects it, so
      // drop the pointer (the VolumeSnapshot itself is GC'd by destroy's
      // label sweep, or overwritten by the next pause).
      this.sandboxes.update(id, {
        spec,
        status: "running",
        pauseSnapshotRef: undefined,
        generated: { agentPassword: boot.agentPassword, podIp: boot.podIp },
      });
    });
    return this.get(id);
  }

  // ── destroy ────────────────────────────────────────────────────────────

  /** Allowed from any status — destroy is the universal recovery exit. */
  async destroy(id: string): Promise<void> {
    return this.withOpLock(id, async () => {
      this.require(id);
      this.agent.invalidatePodIp(id);
      const swept = await this.backend.cleanup(id);
      if (!swept) {
        // Keep the record: deleting it now would orphan whatever the sweep
        // left behind (pod/PVC/snapshots) with nothing to retry destroy from.
        this.sandboxes.update(id, { status: "error" });
        // SandboxError (not plain Error) so the API surfaces the real cause
        // instead of a masked INTERNAL_ERROR in production.
        throw new SandboxError(
          `Failed to clean up resources for sandbox ${id}; record kept — retry destroy`,
          "CLEANUP_FAILED",
          502,
        );
      }
      // The label sweep deleted every sandbox-labeled VolumeSnapshot (pause
      // + manual snapshots); drop their store rows so no dangling ref survives.
      this.snapshots.deleteBySandbox(id);
      // The pod/PVC are gone too, so this sandbox no longer has any toolset
      // mounted — clear its rows or it would permanently pin those refs
      // against the deleteToolset GC guard (§7).
      this.sandboxToolsetRefs.deleteBySandbox(id);
      this.sandboxes.delete(id);
      log.info({ id }, "sandbox destroyed");
    });
  }

  // ── startup reconciliation ────────────────────────────────────────

  /**
   * Reconcile persisted records against the cluster after a server restart,
   * so zombies don't accumulate: a `creating` record means the server died
   * mid-boot — its half-created resources are swept and the record parked in
   * `error` (resumable: `resolveSource` still works from the original spec).
   * A `running` record whose pod is gone (OOM-killed, node lost, manually
   * deleted while the server was down) flips to `error` too — its PVC, if it
   * survived, makes `resume()` a disk-preserving restart.
   */
  async reconcileOnStartup(): Promise<void> {
    if (isMock()) return;
    for (const record of this.sandboxes.list()) {
      try {
        if (record.status === "creating") {
          this.agent.invalidatePodIp(record.id);
          await this.backend.cleanup(record.id);
          // The sweep just tore down whatever pod/PVC this record had, so it
          // no longer has anything mounted — clear its rows or a toolset
          // deleteToolset thinks is still referenced would be permanently
          // pinned against GC (§7) until an explicit resume/destroy overwrites
          // or clears this record.
          this.sandboxToolsetRefs.deleteBySandbox(record.id);
          this.sandboxes.update(record.id, { status: "error" });
          log.warn(
            { id: record.id },
            "swept sandbox stuck in creating (server restarted mid-boot)",
          );
        } else if (record.status === "running") {
          const podName = record.podName ?? `sandbox-${record.id}`;
          if (!(await this.backend.computeExists(record.id))) {
            this.agent.invalidatePodIp(record.id);
            // No pod means nothing has the toolsets mounted right now either
            // (the PVC may survive, but resume() re-derives and re-persists
            // fresh refs on its own boot) — same GC-pinning reasoning as above.
            this.sandboxToolsetRefs.deleteBySandbox(record.id);
            this.sandboxes.update(record.id, { status: "error" });
            log.warn(
              { id: record.id, podName },
              "running sandbox has no pod; marked error (resume restarts it)",
            );
          }
        }
      } catch (err) {
        log.error({ id: record.id, err }, "startup reconciliation failed");
      }
    }
  }

  // ── live mutations ─────────────────────────────────────────────────────

  async patchFiles(id: string, files: PatchFilesRequest): Promise<void> {
    this.require(id);
    await this.agent.writeFiles(id, toFileWrites(files));
  }

  /**
   * Re-export env to future process spawns and fire the `envChanged` hook.
   * Does NOT mutate a running process's environment (stated honestly,
   * atelier-v2 §2 "Runtime API").
   */
  async patchEnv(id: string, env: PatchEnvRequest): Promise<void> {
    const record = this.require(id);
    const nextEnv = { ...(record.spec.env ?? {}), ...env };
    const nextSpec = { ...record.spec, env: nextEnv };
    // Re-push so future process spawns see the new env, then fire envChanged
    // (the agent runs it with the updated pod env). Persist the spec only after
    // the push succeeds, so the store never claims env the agent didn't get.
    // Does not mutate running processes' env (stated honestly, atelier-v2 §2).
    await this.agent.putConfig(id, specToAgentConfig(id, nextSpec));
    this.sandboxes.update(id, { spec: nextSpec });
    await this.runPhase(id, "envChanged");
  }

  async exec(id: string, req: ExecRequest) {
    this.require(id);
    return this.agent.exec(id, req.command, {
      timeout: req.timeoutMs,
      workdir: req.cwd,
      // Default to the sandbox's `dev` user (matches SSH); `root` is opt-in.
      user: req.user ?? "dev",
    });
  }

  async processAction(
    id: string,
    name: string,
    action: "start" | "stop",
  ): Promise<void> {
    this.require(id);
    if (action === "start") await this.agent.processStart(id, name);
    else await this.agent.processStop(id, name);
  }

  async processLogs(id: string, name: string, offset?: number, limit?: number) {
    this.require(id);
    return this.agent.processLogs(id, name, offset, limit);
  }

  /**
   * Register an ad-hoc supervised process after boot: append it to the spec,
   * re-push the config so the agent supervises it (readiness/restart/attach
   * all apply), then start it now unless `lazy` (a lazy process starts on
   * first attach/`start`).
   */
  async addProcess(id: string, req: AddProcessRequest): Promise<void> {
    const record = this.require(id);
    const spec: SandboxSpec = {
      ...record.spec,
      processes: [...(record.spec.processes ?? []), req],
    };
    rejectUnresolvedSecrets(spec);
    await this.agent.putConfig(id, specToAgentConfig(id, spec));
    this.sandboxes.update(id, { spec });
    if (!req.lazy) await this.agent.processStart(id, req.name);
  }

  /** Expose a port after boot — creates the ingress now, real mechanism. */
  async addPort(id: string, req: AddPortRequest): Promise<void> {
    const record = this.require(id);
    const portEntry: PortEntry = {
      name: req.name,
      port: req.port,
      public: req.public ?? true,
    };
    const spec: SandboxSpec = {
      ...record.spec,
      ports: [...(record.spec.ports ?? []), portEntry],
    };
    this.sandboxes.update(id, { spec });
    if (portEntry.public) {
      // The live-added port becomes a Service port + Ingress (mechanism owned
      // by the backend); without it the new Ingress would point at a Service
      // port that doesn't exist until a pause/resume rebuilds the Service.
      await this.backend.exposePort(id, portEntry);
    }
  }

  /**
   * Resolve the WS attach URL for a process's unified bridge (agent-v2
   * attach.rs on :9997). The process is already supervised, so attach just
   * joins its live stdio/PTY stream — `rw` takes the single-writer slot, `ro`
   * fans out read-only. Requires the process to declare `stdio: bridge` or
   * `pty`; a `lazy` one is started here first so its bridge endpoint exists.
   */
  async attach(
    id: string,
    processName: string,
    mode: "rw" | "ro" = "rw",
  ): Promise<{ url: string }> {
    const record = this.require(id);
    const proc = record.spec.processes?.find((p) => p.name === processName);
    if (!proc) throw new NotFoundError("Process", processName);
    if (proc.stdio !== "bridge" && !proc.pty) {
      throw new ValidationError(
        `Process "${processName}" has no attach bridge (needs stdio: bridge or pty)`,
      );
    }
    if (proc.lazy) await this.agent.processStart(id, processName);
    const url = await this.agent.attachUrl(id, processName, mode);
    return { url };
  }

  // ── snapshot ───────────────────────────────────────────────────────────

  /** Promote the current disk → snapshotRef. */
  async snapshot(id: string): Promise<SnapshotRef> {
    return this.withOpLock(id, async () => {
      const record = this.require(id);
      if (record.status !== "running" && record.status !== "paused") {
        throw new ConflictError(
          `Sandbox ${id} is ${record.status}; only a running or paused sandbox has a disk to snapshot`,
        );
      }
      return this.executeSnapshot(record);
    });
  }

  /** Snapshot body, called with the op lock already held (`snapshot` and
   * `pause` both funnel here — `pause` must not re-acquire its own lock). */
  private async executeSnapshot(record: SandboxRecord): Promise<SnapshotRef> {
    const id = record.id;
    const pvcName = record.pvcName ?? `sandbox-${id}`;
    const hash = createHash("sha256")
      .update(`${id}:${Date.now()}`)
      .digest("hex");
    const ref = `snap-${hash.slice(0, 12)}`;
    const { image } = await this.resolveSource(record.spec.source);

    await this.snapshotPvc(pvcName, ref, { "atelier.dev/sandbox": id });

    this.snapshots.put({
      hash,
      ref,
      image,
      // Sandbox-scoped: the VolumeSnapshot carries the sandbox label, so
      // destroy's sweep deletes it — the row must be GC'd with it.
      sandboxId: id,
      createdAt: new Date().toISOString(),
    });
    return { ref, hash };
  }

  /** Snapshot `pvcName` into `ref` via the volume backend (create + wait,
   * idempotent on `ref`). Thin seam kept so the two call sites (prebuild bake,
   * pause/manual snapshot) read the same. */
  private snapshotPvc(
    pvcName: string,
    ref: string,
    labels: Record<string, string>,
    annotations?: Record<string, string>,
  ): Promise<void> {
    return this.backend.volumes.snapshot(pvcName, ref, labels, annotations);
  }

  // ── toolsets ──────────────────────────────────────────

  /**
   * Build a reproducible, input-keyed toolset artifact
   * (composed-prebuild-volumes.md §2). Runs `build[]` in a throwaway pod (as
   * `dev`, so tools land in the home), then has the agent tar the `paths[]`
   * and `oras push` them to the registry. Idempotent: keyed by
   * `hash(source ⊕ build ⊕ paths)`; a hit returns instantly; concurrent builds
   * for the same hash dedupe onto one execution. The registry-push tail
   * replaces `prebuild()`'s snapshot tail — same executor economics.
   */
  async buildToolset(
    req: ToolsetBuildRequest,
    signal?: AbortSignal,
    onLog?: OnLog,
  ): Promise<ToolsetRef> {
    const hash = hashToolset(req);
    const existing = this.toolsets.getByHash(hash);
    if (existing) return { ref: existing.ref };
    const inflight = this.inflightToolsetBuilds.get(hash);
    if (inflight) return inflight;
    const run = this.executeToolsetBuild(req, hash, signal, onLog).finally(
      () => {
        this.inflightToolsetBuilds.delete(hash);
      },
    );
    this.inflightToolsetBuilds.set(hash, run);
    return run;
  }

  private async executeToolsetBuild(
    req: ToolsetBuildRequest,
    hash: string,
    signal?: AbortSignal,
    onLog?: OnLog,
  ): Promise<ToolsetRef> {
    const source = req.source ?? { image: config.sandbox.defaultImage };
    const { image, snapshotName } = await this.resolveSource(source);
    const tempId = `ts-${hash.slice(0, 12)}`;
    const target = `${config.kubernetes.registryUrl}/toolsets/${req.name}:${hash.slice(0, 12)}`;

    return this.withThrowawayPod(
      tempId,
      toolsetToSpec(source, req.env),
      { image, snapshotName },
      "toolset build pod cleanup failed",
      async () => {
        // Build steps run as `dev` so installs land in the home path-sets the
        // artifact captures (running as root would scatter bytes into /root).
        for (const step of req.build) {
          signal?.throwIfAborted();
          await this.execStep(tempId, step, "dev", signal, onLog);
        }
        signal?.throwIfAborted();
        onLog?.("Packing and pushing toolset artifact…");
        const { digest } = await this.agent.buildToolset(
          tempId,
          { target, paths: req.paths },
          signal,
        );
        const ref = `toolsets/${req.name}@${digest}`;
        this.toolsets.put({
          hash,
          name: req.name,
          ref,
          paths: req.paths,
          provenance: { kind: "built", build: req.build },
          private: false,
          createdAt: new Date().toISOString(),
        });
        log.info({ ref, hash, name: req.name }, "toolset artifact built");
        return { ref };
      },
    );
  }

  /**
   * Boot a throwaway pod for a build-then-teardown flow (prebuild bake,
   * toolset build) and guarantee cleanup: the pod + its PVC are torn down in
   * a `finally` regardless of whether `fn` succeeds, and the pod-IP cache
   * entry is invalidated so a reused `tempId` (deterministic per content
   * hash) never dials a stale IP. `fn` receives the boot output (pod/PVC
   * names) and returns the operation's result, which is threaded straight
   * through. Cleanup itself is best-effort — a teardown failure is logged,
   * never thrown, so it can't mask `fn`'s success or replace its error.
   */
  private async withThrowawayPod<T>(
    tempId: string,
    spec: SandboxSpec,
    input: { image: string; snapshotName?: string },
    cleanupFailureMessage: string,
    fn: (boot: BootOutput) => Promise<T>,
  ): Promise<T> {
    const boot = await this.backend.boot(tempId, spec, input, this.agent);
    try {
      return await fn(boot);
    } finally {
      // The pod + throwaway PVC are no longer needed; whatever `fn` produced
      // (a snapshot, a pushed toolset) stands alone. Best-effort so a teardown
      // error never masks the build result.
      this.agent.invalidatePodIp(tempId);
      await this.backend
        .cleanup(tempId)
        .catch((err) => log.warn({ tempId, err }, cleanupFailureMessage));
    }
  }

  listToolsets(): ToolsetEntry[] {
    return this.toolsets.list().map(toolsetRecordToEntry);
  }

  /** Look up a single toolset by ref (control-side guards, e.g. the org
   * publish-before-pin check, need to inspect one entry without listing
   * everything). */
  getToolsetEntry(ref: string): ToolsetEntry | undefined {
    const record = this.toolsets.getByRef(ref);
    return record ? toolsetRecordToEntry(record) : undefined;
  }

  /** Publish a toolset to the org (flip `private` off) — the explicit sharing
   * step for a private-by-default capture (proposal §2). */
  publishToolset(ref: string): ToolsetEntry {
    const record = this.toolsets.getByRef(ref);
    if (!record) throw new NotFoundError("Toolset", ref);
    const next: ToolsetRecord = { ...record, private: false };
    this.toolsets.put(next);
    return toolsetRecordToEntry(next);
  }

  /** Refs a live/paused sandbox currently has mounted — the `deleteToolset`
   * GC guard (toolset-overlay-squashfs.md §7), mirroring
   * `referencedSnapshotRefs()`. Backed by the `sandbox_toolset_refs` join,
   * populated on every successful create/resume boot and cleared on destroy,
   * so it always reflects the current fleet without deserializing every
   * sandbox's `spec` JSON. */
  private referencedToolsetRefs(): Set<string> {
    return this.sandboxToolsetRefs.referencedRefs();
  }

  /** Delete a toolset record. Refuses when a live/paused sandbox still has it
   * mounted (toolset-overlay-squashfs.md §7) — unlike the old extract-into-
   * PVC model, a paused sandbox's squashfs blob lives on its own PVC and
   * never depends on this record surviving, but deleting it out from under a
   * live/paused sandbox would still 404 a future `getByRef`/compose lookup
   * for that ref. The registry blob itself is left to zot retention/GC; this
   * only drops the runtime's handle to it. */
  deleteToolset(ref: string): void {
    const record = this.toolsets.getByRef(ref);
    if (!record) throw new NotFoundError("Toolset", ref);
    if (this.referencedToolsetRefs().has(ref)) {
      throw new ConflictError(
        `Toolset ${ref} is mounted by a live or paused sandbox and cannot be deleted.`,
      );
    }
    this.toolsets.delete(record.hash);
  }

  /** Resolve a host-relative toolset ref (`toolsets/<name>@sha256:…`) to a
   * full pullable registry locator by prepending the configured registry. */
  resolveToolsetRef(ref: string): string {
    return `${config.kubernetes.registryUrl}/${ref}`;
  }

  /**
   * Capture a live sandbox's declared path-sets into a toolset artifact
   * (composed-prebuild-volumes.md §2 "captured (result-keyed)"). The agent
   * tars `paths` minus the merged exclude globs, secret-scans the included
   * files, and pushes — no baseline diff (there's nothing to diff against at
   * capture time; path-set selection + exclude + scan is the honest
   * mechanism). Result-keyed: unlike `buildToolset`, there is no content hash
   * to dedupe on — every capture is a distinct artifact, so it is never
   * silently evictable and is stored private-to-the-capturing-sandbox by
   * default (org publish is a separate, explicit step, out of MVP scope).
   */
  async captureToolset(
    id: string,
    req: ToolsetCaptureRequest,
    signal?: AbortSignal,
    onLog?: OnLog,
  ): Promise<ToolsetRef> {
    this.require(id);
    const target = `${config.kubernetes.registryUrl}/toolsets/${req.name}:cap-${safeNanoid()}`;
    onLog?.(`Capturing ${req.paths.join(", ")} from ${id}…`);
    const { digest } = await this.agent.captureToolset(
      id,
      {
        target,
        paths: req.paths,
        exclude: req.exclude ?? [],
        overrides: req.overrides ?? [],
      },
      signal,
    );
    onLog?.(`Pushed ${req.name}@${digest}`);
    const ref = `toolsets/${req.name}@${digest}`;
    this.toolsets.put({
      // Captures are result-keyed, not input-keyed: the digest is the
      // identity (no `hashToolset`-style pre-image to dedupe concurrent
      // captures on — each run is a distinct snapshot of live, mutable
      // state). Scoped by name: `put` upserts by hash, and two names can
      // legitimately capture byte-identical content (same digest) — they
      // must be two records (own registry repo/retention), not an overwrite.
      hash: createHash("sha256")
        .update(`${req.name}\u0000${digest}`)
        .digest("hex"),
      name: req.name,
      ref,
      paths: req.paths,
      provenance: { kind: "captured", capturedFrom: id },
      private: true,
      createdAt: new Date().toISOString(),
    });
    log.info({ ref, sandboxId: id, name: req.name }, "toolset captured");
    return { ref };
  }

  /** Resolve a source to the concrete image it currently pulls (digest-
   * pinned where possible) — used for toolbox-version provenance/drift
   * (docs/toolbox-versions.md §5), not spawn itself. */
  async resolveSourceImage(source: SandboxSpec["source"]): Promise<string> {
    return (await this.resolveSource(source)).image;
  }

  /** The sandbox's current base image, resolved the same way a spawn would
   * (docs/toolbox-versions.md §5 drift badge). */
  async getSandboxImage(id: string): Promise<string> {
    return this.resolveSourceImage(this.require(id).spec.source);
  }

  /** The configured default base image — exposed so the api/ seam can
   * resolve "current source image" for a toolbox with no explicit `source`
   * without importing `shared/lib/config` across the runtime/control
   * boundary. */
  defaultImage(): string {
    return config.sandbox.defaultImage;
  }

  /** Resolve a spec's `toolsets[]` to full pull references for materialize,
   * or undefined when the spec declares none. */
  private resolveSpecToolsets(spec: SandboxSpec): string[] | undefined {
    if (!spec.toolsets || spec.toolsets.length === 0) return undefined;
    return spec.toolsets.map((t) => this.resolveToolsetRef(t.ref));
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private require(id: string): SandboxRecord {
    const record = this.sandboxes.get(id);
    if (!record) throw new NotFoundError("Sandbox", id);
    return record;
  }

  /** Serialize lifecycle operations per sandbox id: each op chains onto the
   * tail of the previous one (fulfilled or rejected — a failed pause must
   * not poison a queued destroy). Ops re-read the record after acquiring
   * the lock, so a queued duplicate (double resume) fails the status guard
   * instead of racing. The entry is dropped when the tail drains. */
  private async withOpLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.opLocks.get(id) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.opLocks.set(id, tail);
    tail.finally(() => {
      if (this.opLocks.get(id) === tail) this.opLocks.delete(id);
    });
    return run;
  }

  private async resolveSource(
    source: SandboxSpec["source"],
  ): Promise<{ image: string; snapshotName?: string }> {
    if ("snapshot" in source) {
      const snap =
        this.snapshots.get(source.snapshot) ??
        this.snapshots.getByHash(source.snapshot);
      if (!snap) throw new NotFoundError("Snapshot", source.snapshot);
      return { image: snap.image, snapshotName: snap.ref };
    }
    return { image: await this.resolveImage(source) };
  }

  /** Only ever called by `resolveSource` with a non-snapshot source (the
   * `"snapshot" in source` case is resolved there before this runs). */
  private async resolveImage(
    source: Exclude<SandboxSpec["source"], { snapshot: string }>,
  ): Promise<string> {
    // A fully-qualified ref (registry/host or digest) is used verbatim; the
    // gate below only applies to bare names resolved against the configured
    // (in-cluster) registry — an external ref (GHCR, a public tag, another
    // registry entirely) can't be validated by a HEAD against OUR registry,
    // so it would false-negative every BYO image. Let the pod's own pull
    // surface a real error for those instead (design review R1).
    if (source.image.includes("/") || source.image.includes("@")) {
      return source.image;
    }
    // Prefer a built/registered image's already-pinned ref: a `ready`
    // `images` row carries the exact digest we pushed (`<registry>/<name>@
    // sha256:…`) or, for an `external` registration, the verbatim BYO ref.
    // Using it skips BOTH registry round-trips below (the gate HEAD +
    // resolveImageReference) and pins the same immutable digest the build
    // produced — the design-review §5 consistency win. A row that isn't
    // `ready` (building/error) or has no ref falls through to the live gate,
    // which surfaces the right "not available yet" error.
    const record = this.images.get(source.image);
    if (record?.status === "ready" && record.ref) {
      return record.ref;
    }
    // Fail CLOSED on a confirmed-missing image (404) and on an indeterminate
    // registry (network failure/timeout) alike — the prior behaviour only
    // hard-failed on 404 and silently proceeded on `null`, which let a spawn
    // through to hang on ImagePullBackOff against a flaky registry instead of
    // surfacing a clean, retryable error here. `resolveOrAssert` does this in
    // a SINGLE HEAD instead of the previous `imageExists` + `resolveImageReference`
    // pair (design review P2b) — no `images` row (a bare image built
    // out-of-band, or the seed pushed before this table existed) means one
    // round-trip resolves `:latest` to its current digest.
    const result = await ImageRegistryService.resolveOrAssert(source.image);
    if ("missing" in result) {
      throw new ImageNotAvailableError(source.image);
    }
    if ("unreachable" in result) {
      throw new RegistryUnreachableError(source.image);
    }
    return result.ref;
  }

  /**
   * `live` process statuses gate `ready` (design ui-evolution.md §4.1) —
   * omitted at create time (nothing has started yet), present at `get()`.
   */
  private async urlsFor(id: string, spec: SandboxSpec, live?: ProcessStatus[]) {
    const publicPorts = (spec.ports ?? []).filter((p) => p.public);
    const liveByName = new Map((live ?? []).map((p) => [p.name, p]));
    // The backend shapes the host/scheme (port URLs + the ssh entry); the
    // readiness overlay below is backend-neutral policy. The ssh entry (and
    // any non-public port) matches no public port and passes through untouched
    // — assuming no public port is itself named "ssh" (unenforced, but such a
    // spec was already ambiguous pre-refactor: it emitted two "ssh" URLs).
    return (await this.backend.urls(id, spec)).map((url) => {
      // Correlate by name, not array index: both derive from the same
      // `public` filter today, but a name lookup can't silently mispair if
      // the URL ordering ever changes.
      const port = publicPorts.find((p) => p.name === url.name);
      const processes = port ? gatingProcessNames(port, spec.processes) : [];
      if (processes.length === 0) return url;
      const ready =
        live === undefined
          ? undefined
          : processes.every((name) => {
              const p = liveByName.get(name);
              return (p?.ready ?? p?.running) === true;
            });
      return { ...url, processes, ready };
    });
  }

  private async processStatuses(
    record: SandboxRecord,
  ): Promise<ProcessStatus[]> {
    if (record.status !== "running") return [];
    // Union the live agent view with the spec's *declared* processes: a lazy
    // process that hasn't started yet is absent from the supervisor, so
    // without this a `lazy` tool (vscode, browser) would be invisible in the
    // UI — no row, no Start button. Declared-not-live → shown as stopped.
    const declared = record.spec.processes ?? [];
    let live: Awaited<ReturnType<typeof this.agent.processList>>["processes"] =
      [];
    try {
      ({ processes: live } = await this.agent.processList(record.id));
    } catch {
      // Agent unreachable: still surface the declared set so the UI isn't blank.
    }
    const liveByName = new Map(live.map((p) => [p.name, p]));
    const names = new Set<string>([
      ...live.map((p) => p.name),
      ...declared.map((p) => p.name),
    ]);
    return [...names].map((name) => {
      const p = liveByName.get(name);
      const decl = declared.find((d) => d.name === name);
      return {
        name,
        running: p?.status === "running",
        ready: p?.ready,
        primary: p?.primary ?? decl?.primary,
        exitCode: p?.exitCode,
      };
    });
  }

  /** Run a lifecycle phase's hooks in the guest, failing the operation if a
   * hook fails (the agent runs them in order, fail-fast). */
  private async runPhase(id: string, phase: HookPhase): Promise<void> {
    const result = await this.agent.runHook(id, phase);
    if (!result.success) {
      const failed = result.results.find((r) => r.exitCode !== 0);
      throw new Error(
        `${phase} hook failed${failed ? `: '${failed.command}' exited ${failed.exitCode}: ${failed.stderr.trim()}` : ""}`,
      );
    }
  }

  /** Boot gate on the spec's `primary` process readiness (generic,
   * harness-agnostic — not hardcoded to opencode). No-op when no primary. */
  private async gateOnPrimary(id: string): Promise<void> {
    const ready = await this.agent.waitForPrimary(id, { timeout: 120_000 });
    if (!ready) {
      throw new Error(`Sandbox ${id} primary process did not become ready`);
    }
  }
}

// ── module helpers ─────────────────────────────────────────────────────────

/** `spec.toolsets` has no schema-level uniqueness guarantee — TypeBox lacks
 * `uniqueItems` (see the doc comment on `SandboxSpecSchema.toolsets`) and
 * dedup otherwise only happens downstream (agent-side overlay assembly),
 * silently. Reject a duplicate `ref` here with a clean 400 instead (design
 * review H8). */
function rejectDuplicateToolsetRefs(spec: SandboxSpec): void {
  if (!spec.toolsets || spec.toolsets.length < 2) return;
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const t of spec.toolsets) {
    if (seen.has(t.ref)) duplicates.add(t.ref);
    seen.add(t.ref);
  }
  if (duplicates.size > 0) {
    throw new ValidationError(
      `Spec contains duplicate toolset references: ${[...duplicates].join(", ")}.`,
    );
  }
}

function rejectUnresolvedSecrets(spec: SandboxSpec): void {
  const offenders: string[] = [];
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    if (isSecretRef(v)) offenders.push(`env.${k}`);
  }
  for (const f of spec.files ?? []) {
    if (isSecretRef(f.content)) offenders.push(`files[${f.path}]`);
  }
  for (const p of spec.processes ?? []) {
    for (const [k, v] of Object.entries(p.env ?? {})) {
      if (isSecretRef(v)) offenders.push(`processes[${p.name}].env.${k}`);
    }
  }
  if (offenders.length > 0) {
    throw new ValidationError(
      `Spec contains unresolved secret references: ${offenders.join(", ")}. ` +
        "Secrets must be resolved by control before crossing the seam.",
    );
  }
}

function mergeResume(spec: SandboxSpec, req: ResumeRequest): SandboxSpec {
  // Files merge keyed by path (incoming wins): resume re-injects rotated
  // credentials every cycle, so an append would grow `spec.files` — which is
  // persisted back onto the record — without bound.
  let files = spec.files;
  if (req.files) {
    const incoming = new Set(req.files.map((f) => f.path));
    files = [
      ...(spec.files ?? []).filter((f) => !incoming.has(f.path)),
      ...req.files,
    ];
  }
  return {
    ...spec,
    files,
    env: req.env ? { ...(spec.env ?? {}), ...req.env } : spec.env,
  };
}

/** Synthesize the minimal SandboxSpec the prebuild pod boots from: source +
 * default resources + staged files + build env. No processes/ports (nothing
 * to supervise or expose while baking). */
function prebuildToSpec(spec: PrebuildSpec): SandboxSpec {
  return {
    source: spec.source,
    resources: { vcpus: 2, memoryMb: 2048 },
    files: spec.files,
    env: spec.env,
  };
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

/** Single-quote a shell argument (POSIX), escaping embedded single quotes. */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Synthesize the minimal SandboxSpec a toolset build pod boots from: source +
 * default resources + build env. No processes/ports/files — nothing to
 * supervise or expose while installing tools into the home. */
function toolsetToSpec(
  source: SandboxSpec["source"],
  env?: Record<string, string>,
): SandboxSpec {
  return {
    source,
    resources: { vcpus: 2, memoryMb: 2048 },
    ...(env && { env }),
  };
}

/** Drop the internal `hash` (dedup key) so the listed shape matches the
 * `ToolsetEntry` wire schema (`additionalProperties: false`). */
function toolsetRecordToEntry(record: ToolsetRecord): ToolsetEntry {
  const { hash: _hash, ...entry } = record;
  return entry;
}

/** `spec.toolsets[].ref` is host-relative and digest-pinned
 * (`toolsets/<name>@sha256:<64 hex>`, `ToolsetRefSchema`'s pattern) — the
 * digest is trivially the substring after `@sha256:`. Used to populate the
 * `sandbox_toolset_refs` join (toolset-overlay-squashfs.md §6-7): the
 * digest column is denormalized so resume/GC never re-parse the ref. */
function toRefEntries(
  toolsetRefs: SandboxSpec["toolsets"],
): Array<{ ref: string; digest: string }> {
  if (!toolsetRefs || toolsetRefs.length === 0) return [];
  return toolsetRefs.map((t) => {
    const digest = t.ref.slice(t.ref.indexOf("@sha256:") + 1);
    return { ref: t.ref, digest };
  });
}

function hashToolset(req: ToolsetBuildRequest): string {
  // `name` IS keyed: it's the artifact's registry repo (own tag namespace,
  // own retention window), and the stored ref embeds it — so two names must
  // build two artifacts, not alias onto the first-built ref. `env` is
  // build-time secret material, excluded like `PrebuildSpec.env`.
  const keyed = {
    name: req.name,
    source: req.source ?? null,
    build: req.build,
    paths: req.paths,
  };
  return createHash("sha256").update(JSON.stringify(keyed)).digest("hex");
}
