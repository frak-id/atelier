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
import { NotFoundError, ValidationError } from "../shared/errors.ts";
import { config, isMock } from "../shared/lib/config.ts";
import {
  buildGitAttributionFiles,
  GIT_CREDENTIALS_PATH,
} from "../shared/lib/git-attribution.ts";
import { safeNanoid } from "../shared/lib/id.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { HookPhase } from "./agent/index.ts";
import { AgentClient } from "./agent/index.ts";
import { specToAgentConfig } from "./agent-config.ts";
import { bootSandbox, deleteRestartableResources } from "./boot.ts";
import { cleanupSandboxResources } from "./cleanup.ts";
import { getRemoteCommitHash } from "./git-remote.ts";
import { buildVolumeSnapshot, kubeClient } from "./kube/index.ts";
import {
  buildPortIngresses,
  buildPortUrls,
  gatingProcessNames,
  sshUrl,
} from "./ports.ts";
import { ImageRegistryService } from "./registry/index.ts";
import {
  InMemorySandboxStore,
  InMemorySnapshotStore,
  InMemoryToolsetStore,
  type SandboxRecord,
  type SandboxStore,
  type SnapshotStore,
  type ToolsetRecord,
  type ToolsetStore,
} from "./store.ts";

const log = createChildLogger("runtime");

export interface RuntimeCreateOptions {
  /** Externally-chosen sandbox id (control assigns it). Defaults to a nanoid. */
  id?: string;
  /** SSH public keys authorized on the pipe — content resolved by the caller. */
  authorizedKeys?: string[];
}

export interface RuntimeDeps {
  agent?: AgentClient;
  sandboxes?: SandboxStore;
  snapshots?: SnapshotStore;
  toolsets?: ToolsetStore;
}

export class RuntimeService {
  private readonly agent: AgentClient;
  private readonly sandboxes: SandboxStore;
  private readonly snapshots: SnapshotStore;
  private readonly toolsets: ToolsetStore;
  /** De-dupes concurrent prebuild() calls for the same content hash onto one
   * execution (the temp pod name is deterministic and would collide). */
  private readonly inflightPrebuilds = new Map<string, Promise<SnapshotRef>>();
  /** De-dupes concurrent built-toolset executions by content hash (the temp
   * pod name is deterministic and would otherwise collide). */
  private readonly inflightToolsetBuilds = new Map<
    string,
    Promise<ToolsetRef>
  >();

  constructor(deps: RuntimeDeps = {}) {
    this.agent = deps.agent ?? new AgentClient();
    this.sandboxes = deps.sandboxes ?? new InMemorySandboxStore();
    this.snapshots = deps.snapshots ?? new InMemorySnapshotStore();
    this.toolsets = deps.toolsets ?? new InMemoryToolsetStore();
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
    options: { force?: boolean; githubToken?: string } = {},
  ): Promise<SnapshotRef> {
    const { hash, image, snapshotName } = await this.resolveContentKey(spec);
    if (!options.force) {
      const existing = this.snapshots.getByHash(hash);
      if (existing) {
        return { ref: existing.ref, hash, parent: existing.parent };
      }
    }
    const inflight = this.inflightPrebuilds.get(hash);
    if (inflight) return inflight;
    const run = this.executePrebuild(
      spec,
      hash,
      image,
      snapshotName,
      options.githubToken,
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
    if (!isMock()) {
      await kubeClient
        .deleteResource("VolumeSnapshot", ref)
        .catch((err) => log.warn({ ref, err }, "VolumeSnapshot delete failed"));
    }
    this.snapshots.delete(ref);
    log.info({ ref }, "snapshot deleted");
  }

  /** Cron entry: for every stored prebuild that clones repos, recompute the
   * content key (which now reflects current remote HEADs + base image
   * digest). A changed key means upstream moved — rebuild to a fresh
   * snapshot. A key that already resolves to an existing snapshot is skipped
   * (already refreshed). */
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
        // The fresh snapshot supersedes this one; drop it so drifted prebuilds
        // don't accumulate. Kept if something still references it (a running
        // sandbox booted from it, or a prebuild chained on it).
        if (!this.referencedSnapshotRefs().has(snap.ref)) {
          await this.removeSnapshot(snap.ref);
        }
      } catch (err) {
        log.error({ ref: snap.ref, err }, "prebuild staleness check failed");
      }
    }
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
    const boot = await bootSandbox(
      tempId,
      prebuildToSpec(spec),
      { image, snapshotName },
      this.agent,
    );
    try {
      // Inject the git credential transiently — via the agent, NOT the boot
      // spec's files[] — so the token neither enters the content hash nor is
      // baked into the snapshot. Written before clone/build so private repos
      // authenticate through the `store` credential helper.
      if (githubToken) {
        await this.agent.writeFiles(
          tempId,
          buildGitAttributionFiles({ githubToken }).map((f) => ({
            path: f.path,
            content: f.content as string,
            mode: f.mode,
            owner: f.owner as "dev" | "root" | undefined,
          })),
        );
      }
      await this.runPrebuildSteps(tempId, spec);
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
    } finally {
      // The pod + throwaway PVC are no longer needed; the snapshot stands
      // alone. Best-effort so a teardown error never masks the build result.
      this.agent.invalidatePodIp(tempId);
      await cleanupSandboxResources(tempId, { podName: boot.podName }).catch(
        (err) => log.warn({ tempId, err }, "prebuild pod cleanup failed"),
      );
    }
  }

  /** Clone repos then run build[] in the prebuild pod, fail-fast. The prebuild
   * `env` rides the pod env (pushed at boot), so build steps inherit it under
   * `/bin/bash -l`. */
  private async runPrebuildSteps(
    tempId: string,
    spec: PrebuildSpec,
  ): Promise<void> {
    for (const repo of spec.repos ?? []) {
      const branch = repo.branch ? `-b ${shellQuote(repo.branch)} ` : "";
      await this.execStep(
        tempId,
        `git clone --depth 1 ${branch}${shellQuote(repo.url)} ${shellQuote(repo.clonePath)}`,
      );
    }
    for (const step of spec.build ?? []) {
      await this.execStep(tempId, step);
    }
  }

  private async execStep(
    tempId: string,
    command: string,
    user?: "dev" | "root",
  ): Promise<void> {
    const res = await this.agent.exec(tempId, command, {
      timeout: 600_000,
      user,
    });
    if (res.exitCode !== 0) {
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
    const id = options.id ?? safeNanoid();
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

    try {
      // bootSandbox pushes config + writes files[]. The fixed phase order
      // (atelier-v2 §6): files/env -> postCreate -> processes -> postStart.
      const boot = await bootSandbox(
        id,
        spec,
        {
          image,
          snapshotName,
          authorizedKeys: options.authorizedKeys,
          toolsets: this.resolveSpecToolsets(spec),
        },
        this.agent,
      );
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
        urls: this.urlsFor(id, spec),
        generated: { agentPassword: boot.agentPassword, podIp: boot.podIp },
      };
    } catch (error) {
      // A failure in a post-boot phase (hooks/reconcile/primary gate) would
      // otherwise orphan the running pod; tear it down so the boot is atomic
      // (bootSandbox already cleans up failures during its own phase).
      this.agent.invalidatePodIp(id);
      await cleanupSandboxResources(id, { podName: `sandbox-${id}` });
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
      urls: this.urlsFor(id, record.spec, processes),
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

  /** Snapshot the disk, release compute (delete pod, keep PVC). */
  async pause(id: string): Promise<SnapshotRef> {
    this.require(id);
    const ref = await this.snapshot(id);
    this.agent.invalidatePodIp(id);
    await deleteRestartableResources(id);
    this.sandboxes.update(id, { status: "paused" });
    log.info({ id, ref: ref.ref }, "sandbox paused");
    return ref;
  }

  /** Boot from the pause snapshot, injecting rotated files/env, run onResume. */
  async resume(id: string, req: ResumeRequest = {}): Promise<SandboxState> {
    const record = this.require(id);
    const spec = mergeResume(record.spec, req);
    rejectUnresolvedSecrets(spec);
    const { image, snapshotName } = await this.resolveSource(spec.source);

    // Resume phase order: files/env -> onResume -> processes. onResume is the
    // credential-rotation primitive; it runs before processes restart.
    const boot = await bootSandbox(
      id,
      spec,
      { image, snapshotName },
      this.agent,
    );
    try {
      await this.runPhase(id, "onResume");
      await this.agent.reconcile(id);
      await this.gateOnPrimary(id);
    } catch (error) {
      // Tear down the half-resumed pod and stay paused so a retry starts clean
      // (the pod name is fixed per sandbox; a second boot would collide).
      this.agent.invalidatePodIp(id);
      await deleteRestartableResources(id);
      this.sandboxes.update(id, { status: "paused" });
      throw error;
    }
    this.sandboxes.update(id, {
      spec,
      status: "running",
      generated: { agentPassword: boot.agentPassword, podIp: boot.podIp },
    });
    return this.get(id);
  }

  // ── destroy ────────────────────────────────────────────────────────────

  async destroy(id: string): Promise<void> {
    this.require(id);
    this.agent.invalidatePodIp(id);
    await cleanupSandboxResources(id, { podName: `sandbox-${id}` });
    this.sandboxes.delete(id);
    log.info({ id }, "sandbox destroyed");
  }

  // ── live mutations ─────────────────────────────────────────────────────

  async patchFiles(id: string, files: PatchFilesRequest): Promise<void> {
    this.require(id);
    await this.agent.writeFiles(
      id,
      files.map((f) => ({
        path: f.path,
        content: f.content,
        mode: f.mode,
        owner: f.owner as "dev" | "root" | undefined,
      })),
    );
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

  async processLogs(id: string, name: string) {
    this.require(id);
    return this.agent.processLogs(id, name);
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
      for (const resource of buildPortIngresses(id, [portEntry])) {
        await kubeClient.createResource(resource);
      }
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
    const record = this.require(id);
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
      createdAt: new Date().toISOString(),
    });
    return { ref, hash };
  }

  /** Create a VolumeSnapshot of `pvcName` named `ref` and wait until ready.
   * Idempotent: a forced rebuild can resolve to a `ref` that already exists
   * (same hash slice), so any prior snapshot of that name is deleted first
   * instead of 409ing the create. */
  private async snapshotPvc(
    pvcName: string,
    ref: string,
    labels: Record<string, string>,
    annotations?: Record<string, string>,
  ): Promise<void> {
    if (!isMock() && (await kubeClient.resourceExists("VolumeSnapshot", ref))) {
      await kubeClient.deleteResource("VolumeSnapshot", ref);
      await kubeClient.waitForResourceDeleted("VolumeSnapshot", ref, {
        timeout: 60_000,
      });
    }
    await kubeClient.createResource(
      buildVolumeSnapshot({ name: ref, pvcName, labels, annotations }),
    );
    await kubeClient.waitForVolumeSnapshotReady(ref, { timeout: 120_000 });
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
  async buildToolset(req: ToolsetBuildRequest): Promise<ToolsetRef> {
    const hash = hashToolset(req);
    const existing = this.toolsets.getByHash(hash);
    if (existing) return { ref: existing.ref };
    const inflight = this.inflightToolsetBuilds.get(hash);
    if (inflight) return inflight;
    const run = this.executeToolsetBuild(req, hash).finally(() => {
      this.inflightToolsetBuilds.delete(hash);
    });
    this.inflightToolsetBuilds.set(hash, run);
    return run;
  }

  private async executeToolsetBuild(
    req: ToolsetBuildRequest,
    hash: string,
  ): Promise<ToolsetRef> {
    const source = req.source ?? { image: config.sandbox.defaultImage };
    const { image, snapshotName } = await this.resolveSource(source);
    const tempId = `ts-${hash.slice(0, 12)}`;
    const target = `${config.kubernetes.registryUrl}/toolsets/${req.name}:${hash.slice(0, 12)}`;

    const boot = await bootSandbox(
      tempId,
      toolsetToSpec(source, req.env),
      { image, snapshotName },
      this.agent,
    );
    try {
      // Build steps run as `dev` so installs land in the home path-sets the
      // artifact captures (running as root would scatter bytes into /root).
      for (const step of req.build) {
        await this.execStep(tempId, step, "dev");
      }
      const { digest } = await this.agent.buildToolset(tempId, {
        target,
        paths: req.paths,
      });
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
    } finally {
      this.agent.invalidatePodIp(tempId);
      await cleanupSandboxResources(tempId, { podName: boot.podName }).catch(
        (err) => log.warn({ tempId, err }, "toolset build pod cleanup failed"),
      );
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

  /** Delete a toolset record. The registry blob is left to zot retention/GC;
   * this drops the runtime's handle to it. */
  deleteToolset(ref: string): void {
    const record = this.toolsets.getByRef(ref);
    if (!record) throw new NotFoundError("Toolset", ref);
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
  ): Promise<ToolsetRef> {
    this.require(id);
    const target = `${config.kubernetes.registryUrl}/toolsets/${req.name}:cap-${safeNanoid()}`;
    const { digest } = await this.agent.captureToolset(id, {
      target,
      paths: req.paths,
      exclude: req.exclude ?? [],
      overrides: req.overrides ?? [],
    });
    const ref = `toolsets/${req.name}@${digest}`;
    this.toolsets.put({
      // Captures are result-keyed, not input-keyed: the digest itself is the
      // identity (no `hashToolset`-style pre-image to dedupe concurrent
      // captures on — each run is a distinct snapshot of live, mutable state).
      hash: digest,
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

  private resolveImage(source: SandboxSpec["source"]): Promise<string> {
    if ("snapshot" in source) {
      const snap = this.snapshots.get(source.snapshot);
      return Promise.resolve(snap?.image ?? source.snapshot);
    }
    // A fully-qualified ref (registry/host or digest) is used verbatim;
    // a bare name is resolved against the configured registry.
    if (source.image.includes("/") || source.image.includes("@")) {
      return Promise.resolve(source.image);
    }
    return ImageRegistryService.resolveImageReference(source.image);
  }

  /**
   * `live` process statuses gate `ready` (design ui-evolution.md §4.1) —
   * omitted at create time (nothing has started yet), present at `get()`.
   */
  private urlsFor(id: string, spec: SandboxSpec, live?: ProcessStatus[]) {
    const publicPorts = (spec.ports ?? []).filter((p) => p.public);
    const liveByName = new Map((live ?? []).map((p) => [p.name, p]));
    const urls = buildPortUrls(id, spec.ports).map((url) => {
      // Correlate by name, not array index: both derive from the same
      // `public` filter today, but a name lookup can't silently mispair if
      // `buildPortUrls` ordering ever changes.
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
    return [...urls, { name: "ssh", url: sshUrl(id) }];
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

  /** Boot gate on the spec's `primary` process readiness (generic replacement
   * for v1's hardcoded opencode boot-waiter). No-op when no primary. */
  private async gateOnPrimary(id: string): Promise<void> {
    const ready = await this.agent.waitForPrimary(id, { timeout: 120_000 });
    if (!ready) {
      throw new Error(`Sandbox ${id} primary process did not become ready`);
    }
  }
}

// ── module helpers ─────────────────────────────────────────────────────────

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
  return {
    ...spec,
    files: req.files ? [...(spec.files ?? []), ...req.files] : spec.files,
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
