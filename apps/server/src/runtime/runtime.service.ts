/**
 * `RuntimeService` — THE SEAM. `runtime.create(spec)` as a function signature
 * that policy code cannot reach past (design.md §3). Mechanism only: it knows
 * how to boot/pause/resume/destroy, push files/env, supervise processes,
 * expose ports, run hooks, exec, and snapshot. It never parses ACP, reads a
 * harness config, or models "MCP". It imports nothing from control/ or
 * sessions/.
 *
 * This class owns the sandbox lifecycle. Prebuilds (`PrebuildService`) and
 * toolsets (`ToolsetService`) are sub-services it builds from the same
 * dependencies; their public methods are re-exposed here so callers keep one
 * entry point, and api/ may also reach them as `runtime.prebuilds` /
 * `runtime.toolsets`.
 */
import {
  type ActivitySignal,
  type AddPortRequest,
  type AddProcessRequest,
  type CreateSandboxResponse,
  type ExecRequest,
  gatingProcessNames,
  type PatchEnvRequest,
  type PatchFilesRequest,
  type PortEntry,
  type PrebuildRecord,
  type PrebuildSpec,
  type ProcessStatus,
  type ResumeRequest,
  type RuntimeSurface,
  SANDBOX_NAME_ANNOTATION,
  type SandboxBootedFrom,
  type SandboxSpec,
  type SandboxState,
  type SandboxStatus,
  type SandboxSummary,
  type SnapshotRef,
  type ToolsetBuildRequest,
  type ToolsetCaptureRequest,
  type ToolsetEntry,
  type ToolsetRef,
  type ToolsetRefreshRequest,
  type ToolsetRefreshResult,
} from "@atelier/spec";
import {
  ConflictError,
  NotFoundError,
  SandboxError,
  ValidationError,
} from "../shared/errors.ts";
import {
  GIT_CREDENTIALS_PATH,
  GITCONFIG_PATH,
} from "../shared/lib/git-attribution.ts";
import { safeNanoid } from "../shared/lib/id.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import {
  defaultImage,
  snapshotManualKeep,
} from "../shared/lib/runtime-config.ts";
import {
  ActivityRecorder,
  type ActivityThresholds,
  type SandboxActivityRecord,
} from "./activity.ts";
import type { HookPhase, WriteFilesResult } from "./agent/index.ts";
import { AgentClient } from "./agent/index.ts";
import { specToAgentConfig } from "./agent-config.ts";
import { createSandboxBackend, type SandboxBackend } from "./backend/index.ts";
import { BuildPods, type OnLog } from "./build-pod.ts";
import { getRemoteCommitHash } from "./git-remote.ts";
import { OpLock } from "./op-lock.ts";
import { writePatchFiles } from "./patch-files.ts";
import {
  type PrebuildOptions,
  PrebuildService,
  type SpawnPrebuild,
} from "./prebuild.service.ts";
import { resourceName } from "./resource-name.ts";
import {
  newSnapshotName,
  referencedSnapshotRefs,
  removeSnapshot,
} from "./snapshot-helpers.ts";
import { type ResolvedSource, SourceResolver } from "./source-resolver.ts";
import {
  mergeResume,
  rejectDuplicateToolsetRefs,
  rejectUnresolvedSecrets,
  resolveSpecToolsets,
  resolveToolsetRef,
  sourceRepos,
  toRefEntries,
} from "./spec-guards.ts";
import {
  DrizzleImageStore,
  DrizzleSandboxStore,
  DrizzleSandboxToolsetRefStore,
  DrizzleSnapshotStore,
  DrizzleToolsetStore,
  type ImageStore,
  type SandboxRecord,
  type SandboxStore,
  type SandboxToolsetRefStore,
  type SnapshotKind,
  type SnapshotStore,
  type ToolsetStore,
} from "./store.ts";
import { ToolsetService } from "./toolset.service.ts";

const log = createChildLogger("runtime");

export interface RuntimeCreateOptions {
  /** Externally-chosen sandbox id (control assigns it). Defaults to a nanoid. */
  id?: string;
  /** Optional boot-progress sink: coarse phase lines streamed to the caller
   * (e.g. the sandbox-create job log the console tails during boot). */
  onProgress?: (msg: string) => void;
}

/** What a fork's `derive` step returns: the copy's spec. */
interface ForkDerivation {
  spec: SandboxSpec;
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
   * so the source resolver can prefer a built image's already-pinned digest
   * over re-resolving `:latest` on every spawn. */
  images?: ImageStore;
  /** Per-sandbox activity clocks (idle auto-pause). Injectable for tests. */
  activity?: ActivityRecorder;
  /** A repo's current remote HEAD (`git ls-remote`). Injectable so tests
   * key prebuilds without network git. */
  remoteHead?: typeof getRemoteCommitHash;
}

export class RuntimeService {
  /** Prebuild bake, recipe surface, staleness, retention. */
  readonly prebuilds: PrebuildService;
  /** Toolset build/refresh/capture/publish/delete. */
  readonly toolsets: ToolsetService;
  private readonly agent: AgentClient;
  private readonly backend: SandboxBackend;
  private readonly sandboxes: SandboxStore;
  private readonly snapshots: SnapshotStore;
  private readonly sandboxToolsetRefs: SandboxToolsetRefStore;
  private readonly resolver: SourceResolver;
  private readonly activity: ActivityRecorder;
  /** Per-sandbox operation lock: lifecycle ops and live mutations on the same
   * id serialize instead of racing. */
  private readonly opLock = new OpLock();

  constructor(deps: RuntimeDeps = {}) {
    // Backend before agent: the agent dials the backend's resolved endpoint
    // (pod IP on k8s, mapped host ports on Docker), so it must be wired to the
    // active backend's resolveAgentEndpoint.
    this.backend = deps.backend ?? createSandboxBackend();
    this.agent =
      deps.agent ??
      new AgentClient((id) => this.backend.resolveAgentEndpoint(id));
    this.sandboxes = deps.sandboxes ?? new DrizzleSandboxStore();
    this.snapshots = deps.snapshots ?? new DrizzleSnapshotStore();
    this.sandboxToolsetRefs =
      deps.sandboxToolsetRefs ?? new DrizzleSandboxToolsetRefStore();
    this.activity = deps.activity ?? new ActivityRecorder();
    this.resolver = new SourceResolver(
      this.snapshots,
      deps.images ?? new DrizzleImageStore(),
    );
    const buildPods = new BuildPods(this.backend, this.agent);
    this.prebuilds = new PrebuildService({
      agent: this.agent,
      backend: this.backend,
      sandboxes: this.sandboxes,
      snapshots: this.snapshots,
      resolver: this.resolver,
      buildPods,
      remoteHead: deps.remoteHead ?? getRemoteCommitHash,
    });
    this.toolsets = new ToolsetService({
      agent: this.agent,
      sandboxes: this.sandboxes,
      toolsets: deps.toolsets ?? new DrizzleToolsetStore(),
      sandboxToolsetRefs: this.sandboxToolsetRefs,
      resolver: this.resolver,
      buildPods,
    });
  }

  // ── activity (idle auto-pause) ────────────────────────────────────────

  /** Record that a signal was just seen for a sandbox (SSH bytes, a relayed
   * keystroke, ACP traffic). The idle rules decide what counts. */
  touch(id: string, signal: ActivitySignal): void {
    this.activity.touch(id, signal);
  }

  /** The sandbox's activity clocks (an empty record floored at the server's
   * start when nothing was seen yet). */
  activityRecord(id: string): SandboxActivityRecord {
    return this.activity.read(id);
  }

  /** Whether a lifecycle op (create/pause/resume/snapshot/destroy/fork) holds
   * the sandbox's op lock right now. */
  hasPendingOp(id: string): boolean {
    return this.opLock.has(id);
  }

  /**
   * Poll the agent's `GET /activity` and fold it into the sandbox's clocks
   * with `thresholds`. An unreachable agent is recorded as not reporting;
   * never throws.
   */
  async pollActivity(
    id: string,
    thresholds: ActivityThresholds,
  ): Promise<void> {
    try {
      const report = await this.agent.activity(id);
      this.activity.ingest(id, report, thresholds);
    } catch (err) {
      log.debug({ id, err }, "activity poll failed");
      this.activity.markUnreported(id);
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
    return this.opLock.run(id, () => this.executeCreate(id, spec, options));
  }

  private async executeCreate(
    id: string,
    spec: SandboxSpec,
    options: RuntimeCreateOptions,
  ): Promise<CreateSandboxResponse> {
    if (this.sandboxes.get(id)) {
      throw new ConflictError(`Sandbox ${id} already exists`);
    }
    const progress = options.onProgress ?? (() => {});
    const resolved = await this.resolver.resolveSource(spec.source);
    progress(`source resolved (${resolved.snapshotName ?? resolved.image})`);
    this.registerCreating(id, spec);
    return this.bootNew(id, spec, resolved, options);
  }

  /** Insert the `creating` record — the sandbox is visible from here on. */
  private registerCreating(id: string, spec: SandboxSpec): void {
    const now = new Date().toISOString();
    this.sandboxes.create({
      id,
      spec,
      status: "creating",
      generated: {},
      metadata: spec.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Boot a registered `creating` sandbox; any failure parks it in `error`. */
  private async bootNew(
    id: string,
    spec: SandboxSpec,
    { image, snapshotName }: { image: string; snapshotName?: string },
    options: RuntimeCreateOptions,
    keepDisk = false,
  ): Promise<CreateSandboxResponse> {
    const progress = options.onProgress ?? (() => {});
    const toolsets = resolveSpecToolsets(spec);
    // The boot image is fixed here, once: pause, resume and the image lookups
    // read it back instead of re-resolving a source that may be gone by then.
    this.sandboxes.update(id, { image });
    // The backend cleans up after a failure inside its own boot; only what
    // went wrong after it returned is the runtime's to tear down.
    let booted = false;
    try {
      // bootSandbox pushes config + writes files[]. The fixed phase order
      // (design.md §6): files/env -> postCreate -> processes -> postStart.
      progress("booting pod…");
      const boot = await this.backend.boot(
        id,
        spec,
        {
          image,
          snapshotName,
          preserveDisk: keepDisk,
          toolsets,
        },
        this.agent,
      );
      booted = true;
      progress("pod up…");
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
      progress("reconciling processes…");
      await this.agent.reconcile(id);
      await this.gateOnPrimary(id);
      progress("primary ready, running postStart…");
      await this.runPhase(id, "postStart");
      progress("sandbox running");

      const generated = {
        agentPassword: boot.agentPassword,
        podIp: boot.podIp,
        sshHostKeys: boot.sshHostKeys,
      };
      this.sandboxes.update(id, {
        status: "running",
        generated,
      });
      // The idle clock starts at boot, not at the first signal.
      this.activity.touch(id, "lifecycle");

      return {
        id,
        urls: await this.urlsFor(id, spec),
        generated,
      };
    } catch (error) {
      this.agent.invalidatePodIp(id);
      // A failure in a post-boot phase (hooks/reconcile/primary gate) would
      // otherwise orphan the running pod; tear it down so the boot is atomic.
      if (booted) {
        try {
          // `keepDisk` (a fork's boot): like a failed resume, keep the disk
          // and the snapshot it boots from (both carry the sandbox label) so
          // the `error` record stays resumable; destroy sweeps them.
          if (keepDisk) await this.backend.deleteRestartable(id);
          else await this.backend.cleanup(id);
        } catch (cleanupError) {
          log.warn(
            { id, err: cleanupError },
            "teardown after failed boot failed",
          );
        }
      }
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
      bootedFrom: this.bootedFrom(record),
    };
  }

  /** The snapshot a sandbox booted from (a prebuild, a fork's or a manual
   * snapshot), so the console can show what it contains and how old it is.
   * Undefined for an image source, or once the snapshot is gone. */
  private bootedFrom(record: SandboxRecord): SandboxBootedFrom | undefined {
    if (!("snapshot" in record.spec.source)) return undefined;
    const snap = this.snapshots.get(record.spec.source.snapshot);
    if (!snap) return undefined;
    return {
      ref: snap.ref,
      kind: snap.kind,
      image: snap.image,
      ...(snap.repoHeads ? { repoHeads: snap.repoHeads } : {}),
      builtAt: snap.createdAt,
    };
  }

  /**
   * The sandbox's pinned sshd host public key line(s), as last reported by
   * the agent at boot/resume — undefined when unknown (not booted since
   * pinning shipped). A cheap,
   * synchronous store read (no agent round-trip): used by the in-server SSH
   * gateway (ssh/proxy.ts) to verify the upstream host key per connection,
   * so it must stay fast.
   */
  getSshHostKeys(id: string): string[] | undefined {
    return this.sandboxes.get(id)?.generated.sshHostKeys;
  }

  /** A sandbox's status, or undefined when it is unknown. A synchronous
   * store read (the idle reaper and list decorations call it per row). */
  getStatus(id: string): SandboxStatus | undefined {
    return this.sandboxes.get(id)?.status;
  }

  /** A sandbox's opaque metadata and annotations, or undefined when it is
   * unknown. A synchronous store read like `getSshHostKeys`: the SSH gateway
   * calls it on every authentication attempt. */
  getLabels(
    id: string,
  ):
    | { metadata: Record<string, string>; annotations: Record<string, string> }
    | undefined {
    const record = this.sandboxes.get(id);
    return (
      record && {
        metadata: record.metadata,
        annotations: record.spec.annotations ?? {},
      }
    );
  }

  /** All sandboxes, from persistence only (no agent round-trips). Live
   * process health is on `get(id)`. With `metadata`, only those whose
   * metadata holds every one of its pairs. */
  list(metadata: Record<string, string> = {}): SandboxSummary[] {
    const snapshots = new Map(this.snapshots.list().map((s) => [s.ref, s]));
    const wanted = Object.entries(metadata);
    return this.sandboxes
      .list()
      .filter((r) => wanted.every(([k, v]) => r.metadata[k] === v))
      .map((r) => {
        const repos = sourceRepos(r.spec, snapshots);
        return {
          id: r.id,
          status: r.status,
          createdAt: r.createdAt,
          metadata: r.metadata,
          annotations: r.spec.annotations,
          ...(repos.length > 0 ? { repos } : {}),
        };
      });
  }

  /**
   * Set (or, with `undefined`, remove) one display annotation. Annotations
   * are display hints the runtime never reads, so this touches no pod and
   * takes no op lock: a rename must not wait out a multi-minute resume. The
   * read-modify-write is synchronous, so it can't interleave with another
   * write; the async spec writers keep the stored annotations (see
   * `withStoredAnnotations`) so they can't clobber it either.
   */
  setAnnotation(id: string, key: string, value: string | undefined): void {
    const record = this.require(id);
    const { [key]: _previous, ...rest } = record.spec.annotations ?? {};
    const annotations = value === undefined ? rest : { ...rest, [key]: value };
    this.sandboxes.update(id, {
      spec: {
        ...record.spec,
        annotations:
          Object.keys(annotations).length > 0 ? annotations : undefined,
      },
    });
  }

  /** `spec` with the annotations currently stored for `id`. For a spec built
   * from a record read before an `await`: `setAnnotation` may have run in
   * between, and its write must survive this one. */
  private withStoredAnnotations(id: string, spec: SandboxSpec): SandboxSpec {
    const stored = this.sandboxes.get(id);
    return stored ? { ...spec, annotations: stored.spec.annotations } : spec;
  }

  // ── pause / resume ─────────────────────────────────────────────────────

  /** Snapshot the disk, release compute (delete pod, keep PVC). The snapshot
   * ref persists on the record: it is `resume()`'s boot source if the PVC is
   * ever lost (a failed resume boot cleans the PVC; the snapshot survives). */
  async pause(id: string): Promise<SnapshotRef> {
    return this.opLock.run(id, async () => {
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
      const ref = await this.executeSnapshot(record, "pause");
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
    await this.opLock.run(id, async () => {
      const record = this.require(id);
      if (record.status !== "paused" && record.status !== "error") {
        throw new ConflictError(
          `Sandbox ${id} is ${record.status}; only a paused or errored sandbox can be resumed`,
        );
      }
      const spec = mergeResume(record.spec, req);
      rejectUnresolvedSecrets(spec);
      const reusePvc = await this.backend.volumes.volumeExists(
        resourceName(id),
      );
      // The image comes from the record (fixed at create); the source is only
      // resolved for a record that predates that, or when the disk must be
      // rebuilt from the original snapshot source (no live disk, no pause
      // snapshot — an `error` record recovering from scratch).
      const needsSourceSnapshot =
        !reusePvc && !record.pauseSnapshotRef && "snapshot" in spec.source;
      const fromSource =
        record.image && !needsSourceSnapshot
          ? { image: record.image }
          : await this.resolver.resolveSource(spec.source);
      const image = record.image ?? fromSource.image;
      const toolsets = resolveSpecToolsets(spec);

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
            : (record.pauseSnapshotRef ?? fromSource.snapshotName),
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
      // The disk is live again — the pause snapshot no longer reflects it
      // (the next pause takes a new, differently named one), so drop the
      // pointer and the snapshot itself.
      this.sandboxes.update(id, {
        spec: this.withStoredAnnotations(id, spec),
        status: "running",
        image,
        pauseSnapshotRef: undefined,
        generated: {
          agentPassword: boot.agentPassword,
          podIp: boot.podIp,
          sshHostKeys: boot.sshHostKeys,
        },
      });
      this.activity.touch(id, "lifecycle");
      if (record.pauseSnapshotRef) {
        await removeSnapshot(
          this.backend,
          this.snapshots,
          record.pauseSnapshotRef,
        ).catch((err) =>
          log.warn(
            { id, ref: record.pauseSnapshotRef, err },
            "pause snapshot cleanup after resume failed",
          ),
        );
      }
    });
    return this.get(id);
  }

  // ── destroy ────────────────────────────────────────────────────────────

  /** Allowed from any status — destroy is the universal recovery exit. */
  async destroy(id: string): Promise<void> {
    return this.opLock.run(id, async () => {
      this.require(id);
      this.agent.invalidatePodIp(id);
      await this.reownReferencedSnapshots(id);
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
      // The label sweep deleted every sandbox-labeled VolumeSnapshot left
      // (pause + manual + fork snapshots no one boots from); drop their store
      // rows so no dangling ref survives.
      this.snapshots.deleteBySandbox(id);
      // The pod/PVC are gone too, so this sandbox no longer has any toolset
      // mounted — clear its rows or it would permanently pin those refs
      // against the deleteToolset GC guard (§7).
      this.sandboxToolsetRefs.deleteBySandbox(id);
      this.sandboxes.delete(id);
      this.activity.forget(id);
      log.info({ id }, "sandbox destroyed");
    });
  }

  /** Hand the snapshots `id` owns that another sandbox boots from to that
   * sandbox, before destroy's label sweep deletes them: it would otherwise
   * break the other sandbox's pause/resume/fork (its source is gone). The
   * new owner's own destroy repeats this for the next dependent. */
  private async reownReferencedSnapshots(id: string): Promise<void> {
    const dependents = new Map<string, string>();
    for (const other of this.sandboxes.list()) {
      if (other.id === id || !("snapshot" in other.spec.source)) continue;
      const ref = other.spec.source.snapshot;
      if (!dependents.has(ref)) dependents.set(ref, other.id);
    }
    for (const snap of this.snapshots.list()) {
      const heir = dependents.get(snap.ref);
      if (snap.sandboxId !== id || !heir) continue;
      await this.backend.volumes.reownSnapshot(snap.ref, heir);
      this.snapshots.put({ ...snap, sandboxId: heir });
      log.info({ ref: snap.ref, from: id, to: heir }, "snapshot re-owned");
    }
  }

  // ── startup reconciliation ────────────────────────────────────────

  /**
   * Reconcile persisted records against the cluster after a server restart,
   * so zombies don't accumulate: a `creating` record means the server died
   * mid-boot — its half-created resources are swept and the record parked in
   * `error` (resumable: the record keeps its boot image and source).
   * A `running` record whose pod is gone (OOM-killed, node lost, manually
   * deleted while the server was down) flips to `error` too — its PVC, if it
   * survived, makes `resume()` a disk-preserving restart.
   */
  async reconcileOnStartup(): Promise<void> {
    for (const record of this.sandboxes.list()) {
      try {
        if (record.status === "creating") {
          this.agent.invalidatePodIp(record.id);
          // A fork copy that already owns its snapshot keeps disk + snapshot
          // (resumable, like a failed fork boot); else the full sweep.
          const src = record.spec.source;
          const ownsSnapshot =
            "snapshot" in src &&
            this.snapshots.get(src.snapshot)?.sandboxId === record.id;
          if (ownsSnapshot) await this.backend.deleteRestartable(record.id);
          else await this.backend.cleanup(record.id);
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
          if (!(await this.backend.computeExists(record.id))) {
            this.agent.invalidatePodIp(record.id);
            // No pod means nothing has the toolsets mounted right now either
            // (the PVC may survive, but resume() re-derives and re-persists
            // fresh refs on its own boot) — same GC-pinning reasoning as above.
            this.sandboxToolsetRefs.deleteBySandbox(record.id);
            this.sandboxes.update(record.id, { status: "error" });
            log.warn(
              { id: record.id, podName: resourceName(record.id) },
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

  /** Write files into a running sandbox, `dev`'s unless an entry says
   * otherwise; `encoding: "base64"` entries carry bytes (see
   * `writePatchFiles`). One result per file, in request order (a file can
   * fail to write without failing the call). */
  async patchFiles(
    id: string,
    files: PatchFilesRequest,
  ): Promise<WriteFilesResult> {
    this.require(id);
    this.activity.touch(id, "api");
    return writePatchFiles(this.agent, id, files);
  }

  /**
   * Re-export env to future process spawns and fire the `envChanged` hook.
   * Does NOT mutate a running process's environment (stated honestly,
   * design.md §2 "Runtime API").
   */
  async patchEnv(id: string, env: PatchEnvRequest): Promise<void> {
    return this.opLock.run(id, async () => {
      const record = this.requireRunning(id);
      this.activity.touch(id, "api");
      const nextEnv = { ...(record.spec.env ?? {}), ...env };
      const nextSpec = { ...record.spec, env: nextEnv };
      // Re-push so future process spawns see the new env, then fire
      // envChanged (the agent runs it with the updated pod env). Persist the
      // spec only after the push succeeds, so the store never claims env the
      // agent didn't get. Does not mutate running processes' env (stated
      // honestly, design.md §2).
      await this.agent.putConfig(id, specToAgentConfig(id, nextSpec));
      this.sandboxes.update(id, {
        spec: this.withStoredAnnotations(id, nextSpec),
      });
      await this.runPhase(id, "envChanged");
    });
  }

  async exec(id: string, req: ExecRequest) {
    this.require(id);
    this.activity.touch(id, "api");
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
    this.activity.touch(id, "api");
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
    return this.opLock.run(id, async () => {
      const record = this.requireRunning(id);
      this.activity.touch(id, "api");
      const spec: SandboxSpec = {
        ...record.spec,
        processes: [...(record.spec.processes ?? []), req],
      };
      rejectUnresolvedSecrets(spec);
      await this.agent.putConfig(id, specToAgentConfig(id, spec));
      this.sandboxes.update(id, {
        spec: this.withStoredAnnotations(id, spec),
      });
      if (!req.lazy) await this.agent.processStart(id, req.name);
    });
  }

  /** Expose a port after boot — creates the ingress now, real mechanism. The
   * spec records the port only once the backend exposed it, so the record
   * never claims a port that has no route. */
  async addPort(id: string, req: AddPortRequest): Promise<void> {
    return this.opLock.run(id, async () => {
      const record = this.requireRunning(id);
      this.activity.touch(id, "api");
      const portEntry: PortEntry = {
        name: req.name,
        port: req.port,
        public: req.public ?? true,
      };
      if (portEntry.public) {
        // The live-added port becomes a Service port + Ingress (mechanism
        // owned by the backend); without it the new Ingress would point at a
        // Service port that doesn't exist until a pause/resume rebuilds the
        // Service.
        await this.backend.exposePort(id, portEntry);
      }
      const spec: SandboxSpec = {
        ...record.spec,
        ports: [...(record.spec.ports ?? []), portEntry],
      };
      this.sandboxes.update(id, {
        spec: this.withStoredAnnotations(id, spec),
      });
    });
  }

  /**
   * Resolve the WS attach URL for a process's unified bridge (agent
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
    // A read-only watcher is not using the sandbox; what a rw attach sends
    // is counted as `console` by the relay.
    if (mode === "rw") this.activity.touch(id, "api");
    if (proc.lazy) await this.agent.processStart(id, processName);
    const url = await this.agent.attachUrl(id, processName, mode);
    return { url };
  }

  // ── snapshot ───────────────────────────────────────────────────────────

  /** Promote the current disk → snapshotRef. Keeps the sandbox's last
   * `snapshot.manualKeep` manual snapshots; older unused ones are deleted. */
  async snapshot(id: string): Promise<SnapshotRef> {
    return this.opLock.run(id, async () => {
      const ref = await this.executeSnapshot(
        this.requireSnapshottable(id),
        "manual",
      );
      await this.pruneManualSnapshots(id);
      return ref;
    });
  }

  /** Retention for a sandbox's manual snapshots. One a sandbox boots from
   * is never deleted (nor counted): destroy hands it on instead. */
  private async pruneManualSnapshots(ownerId: string): Promise<void> {
    const keep = snapshotManualKeep();
    const referenced = referencedSnapshotRefs(this.sandboxes, this.snapshots);
    const unused = this.snapshots
      .list()
      .filter(
        (s) =>
          s.kind === "manual" &&
          s.sandboxId === ownerId &&
          !referenced.has(s.ref),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (const old of unused.slice(keep)) {
      try {
        await removeSnapshot(this.backend, this.snapshots, old.ref);
      } catch (err) {
        log.warn({ ref: old.ref, err }, "manual snapshot prune failed");
      }
    }
  }

  private requireSnapshottable(id: string): SandboxRecord {
    const record = this.require(id);
    if (record.status !== "running" && record.status !== "paused") {
      throw new ConflictError(
        `Sandbox ${id} is ${record.status}; only a running or paused sandbox has a disk to snapshot`,
      );
    }
    return record;
  }

  /** Snapshot body, called with the op lock already held (`snapshot` and
   * `pause` both funnel here — `pause` must not re-acquire its own lock).
   * `ownerId` is the sandbox that owns the snapshot (default: `record`'s own;
   * a fork's snapshot belongs to the copy). */
  private async executeSnapshot(
    record: SandboxRecord,
    kind: Exclude<SnapshotKind, "prebuild">,
    ownerId = record.id,
    { hash, ref } = newSnapshotName(ownerId),
  ): Promise<SnapshotRef> {
    const image = await this.bootImage(record);

    await this.backend.volumes.snapshot(resourceName(record.id), ref, {
      "atelier.dev/sandbox": ownerId,
    });

    this.snapshots.put({
      hash,
      kind,
      ref,
      image,
      // Owner-scoped: the VolumeSnapshot carries the owner's label, so the
      // owner's destroy sweep deletes it — the row must be GC'd with it.
      sandboxId: ownerId,
      createdAt: new Date().toISOString(),
    });
    return { ref, hash };
  }

  /**
   * Snapshot sandbox `sourceId` and boot a new sandbox from that snapshot.
   * Mechanism only: `derive` (policy, supplied by the caller) turns the
   * source's stored spec into the copy's — who owns it, which git identity
   * it carries — and may return the SSH keys to authorize. `name` sets the
   * display name (absent: none, so the copy never poses as its source).
   *
   * The copy's record is registered `creating` synchronously (visible before
   * the snapshot starts) and ends `error` if the snapshot or boot fails. The
   * snapshot is owned by the copy (row + label), so it outlives the source and
   * is swept with the copy. It holds the source's op lock, the boot the copy's.
   */
  async fork(
    sourceId: string,
    fork: {
      derive: (spec: SandboxSpec) => ForkDerivation;
      /** Labels the copy carries until `derive` has run (and if it fails):
       * the caller picks them, so it is never ownerless nor shows the
       * source owner's. */
      initial: {
        metadata: Record<string, string>;
        annotations: Record<string, string>;
      };
      name?: string;
    },
    options: Pick<RuntimeCreateOptions, "id" | "onProgress"> = {},
  ): Promise<CreateSandboxResponse> {
    const id = options.id ?? safeNanoid();
    if (this.sandboxes.get(id)) {
      throw new ConflictError(`Sandbox ${id} already exists`);
    }
    const source = this.requireSnapshottable(sourceId);
    // The copy's snapshot name is fixed now, so the record points at it from
    // the start and can never resume as the source's base image.
    const name = newSnapshotName(id);
    const { [SANDBOX_NAME_ANNOTATION]: _name, ...annotations } =
      source.spec.annotations ?? {};
    // The source owner's git attribution never sits on the copy's record,
    // not even until `derive` runs (or if it fails).
    const gitPaths = new Set([GITCONFIG_PATH, GIT_CREDENTIALS_PATH]);
    const files = source.spec.files?.filter((f) => !gitPaths.has(f.path));
    this.registerCreating(id, {
      ...source.spec,
      files,
      source: { snapshot: name.ref },
      metadata: fork.initial.metadata,
      annotations: fork.initial.annotations,
    });

    return this.opLock.run(id, async () => {
      let forked: SandboxSpec;
      let resolved: ResolvedSource;
      try {
        const derived = fork.derive({ ...source.spec, annotations });
        forked = {
          ...derived.spec,
          source: { snapshot: name.ref },
          annotations: fork.name
            ? {
                ...derived.spec.annotations,
                [SANDBOX_NAME_ANNOTATION]: fork.name,
              }
            : (derived.spec.annotations ?? {}),
        };
        // The stored spec was validated at the source's creation, but derive
        // is caller policy: re-check what boot would reject.
        rejectUnresolvedSecrets(forked);
        rejectDuplicateToolsetRefs(forked);
        this.sandboxes.update(id, {
          spec: forked,
          metadata: forked.metadata ?? {},
        });
        options.onProgress?.(`snapshotting ${sourceId}…`);
        await this.opLock.run(sourceId, async () =>
          this.executeSnapshot(
            this.requireSnapshottable(sourceId),
            "fork",
            id,
            name,
          ),
        );
        resolved = await this.resolver.resolveSource(forked.source);
      } catch (error) {
        // Nothing to keep: sweep a half-made snapshot (labelled with the
        // copy's id). Resume then fails with "Snapshot … not found".
        try {
          await this.backend.cleanup(id);
        } catch (cleanupError) {
          log.warn({ id, err: cleanupError }, "fork cleanup failed");
        }
        this.snapshots.deleteBySandbox(id);
        this.sandboxes.update(id, { status: "error" });
        throw error;
      }
      return this.bootNew(id, forked, resolved, options, true);
    });
  }

  /** Throws unless `id` is a sandbox with a disk to snapshot (404 / 409) —
   * the sync pre-check a caller makes before handing out a fork's id. */
  assertSnapshottable(id: string): void {
    this.requireSnapshottable(id);
  }

  // ── prebuilds & toolsets (delegating to the sub-services) ──────────────

  prebuild(
    spec: PrebuildSpec,
    options?: PrebuildOptions,
  ): Promise<SnapshotRef> {
    return this.prebuilds.prebuild(spec, options);
  }

  cachedPrebuild(
    spec: PrebuildSpec,
    options?: PrebuildOptions,
  ): Promise<SnapshotRef | undefined> {
    return this.prebuilds.cached(spec, options);
  }

  prebuildForSpawn(
    spec: PrebuildSpec,
    options?: PrebuildOptions,
  ): Promise<SpawnPrebuild> {
    return this.prebuilds.prebuildForSpawn(spec, options);
  }

  setPrebuildSurface(ref: string, surface: RuntimeSurface): PrebuildSpec {
    return this.prebuilds.setSurface(ref, surface);
  }

  prebuildSpec(ref: string): PrebuildSpec | undefined {
    return this.prebuilds.specOf(ref);
  }

  prebuildSurface(ref: string): RuntimeSurface {
    return this.prebuilds.surfaceOf(ref);
  }

  listPrebuilds(): PrebuildRecord[] {
    return this.prebuilds.list();
  }

  deletePrebuild(ref: string): Promise<void> {
    return this.prebuilds.delete(ref);
  }

  pruneUnusedPrebuilds(keep: number): Promise<number> {
    return this.prebuilds.prune(keep);
  }

  /** The sandbox a snapshot belongs to (pause/manual/fork snapshots), or
   * undefined for a shared prebuild snapshot or an unknown ref. Resolves by
   * ref or hash; a synchronous store read. */
  snapshotOwner(ref: string): string | undefined {
    return (this.snapshots.get(ref) ?? this.snapshots.getByHash(ref))
      ?.sandboxId;
  }

  /** Every image reference a live sandbox's `source.image` or a stored
   * snapshot's `image` still points at — the read `ImageBuilderService`'s
   * delete guard consumes (across the runtime/registry module seam, so it
   * stays a plain read, no shared mutable state). */
  referencedImageRefs(): string[] {
    const refs: string[] = [];
    for (const s of this.sandboxes.list()) {
      if ("image" in s.spec.source) refs.push(s.spec.source.image);
      if (s.image) refs.push(s.image);
    }
    for (const snap of this.snapshots.list()) {
      refs.push(snap.image);
    }
    return refs;
  }

  buildToolset(
    req: ToolsetBuildRequest,
    signal?: AbortSignal,
    onLog?: OnLog,
  ): Promise<ToolsetRef> {
    return this.toolsets.build(req, signal, onLog);
  }

  refreshToolset(
    req: ToolsetRefreshRequest,
    signal?: AbortSignal,
    onLog?: OnLog,
  ): Promise<ToolsetRefreshResult> {
    return this.toolsets.refresh(req, signal, onLog);
  }

  captureToolset(
    id: string,
    req: ToolsetCaptureRequest,
    signal?: AbortSignal,
    onLog?: OnLog,
  ): Promise<ToolsetRef> {
    return this.toolsets.capture(id, req, signal, onLog);
  }

  listToolsets(): ToolsetEntry[] {
    return this.toolsets.list();
  }

  getToolsetEntry(ref: string): ToolsetEntry | undefined {
    return this.toolsets.getEntry(ref);
  }

  publishToolset(ref: string): ToolsetEntry {
    return this.toolsets.publish(ref);
  }

  deleteToolset(ref: string): void {
    this.toolsets.delete(ref);
  }

  resolveToolsetRef(ref: string): string {
    return resolveToolsetRef(ref);
  }

  /** Resolve a source to the concrete image it currently pulls (digest-
   * pinned where possible) — used for toolbox-version provenance/drift
   * (docs/toolbox-versions.md §5), not spawn itself. */
  async resolveSourceImage(source: SandboxSpec["source"]): Promise<string> {
    return (await this.resolver.resolveSource(source)).image;
  }

  /** The image the sandbox booted from, as fixed at create
   * (docs/toolbox-versions.md §5 drift badge). */
  getSandboxImage(id: string): Promise<string> {
    return this.bootImage(this.require(id));
  }

  /** The configured default base image — exposed so the api/ seam can
   * resolve "current source image" for a toolbox with no explicit `source`
   * without importing `shared/lib/config` across the runtime/control
   * boundary. */
  defaultImage(): string {
    return defaultImage();
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private require(id: string): SandboxRecord {
    const record = this.sandboxes.get(id);
    if (!record) throw new NotFoundError("Sandbox", id);
    return record;
  }

  private requireRunning(id: string): SandboxRecord {
    const record = this.require(id);
    if (record.status !== "running") {
      throw new ConflictError(
        `Sandbox ${id} is ${record.status}; only a running sandbox can be changed live`,
      );
    }
    return record;
  }

  /** The image a sandbox booted from: fixed at create, so it holds even when
   * the source snapshot is gone or the registry is down. Only a record that
   * predates the column resolves its source. */
  private async bootImage(record: SandboxRecord): Promise<string> {
    return (
      record.image ??
      (await this.resolver.resolveSource(record.spec.source)).image
    );
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
