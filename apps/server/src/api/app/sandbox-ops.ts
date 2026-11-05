/**
 * Sandbox operations — the one application layer under `/v1/sandboxes/*`, the
 * sandbox MCP tools, the wake-on-access path and the SSH gateway. Callers
 * authenticate, parse and authorize access to a sandbox id, then call a
 * method here; this is where control (org, toolboxes, enrichment), the
 * runtime and the jobs feed meet:
 *  - every long op (create, fork, pause, resume, snapshot, destroy) runs as a
 *    job, so it shows in the feed whoever started it;
 *  - one resume path (`runtime.resume` re-resolves secrets and the owner's
 *    git credentials at every boot), shared by the HTTP route, MCP and wake;
 *  - operations that need a live agent (exec, files, processes) resume a
 *    paused sandbox first, with a bounded wait.
 */
import {
  buildRepoPrebuildSpec,
  type CreateSandboxRequest,
  type ExecRequest,
  type ForkSandboxRequest,
  findRepoBasePrebuild,
  findRepoBranchPrebuild,
  type PatchFilesRequest,
  type PrebuildRecord,
  type PrebuildSpec,
  prebuildJobTarget,
  prebuildRepoFor,
  type ResumeRequest,
  runtimeSurfaceOf,
  SANDBOX_NAME_ANNOTATION,
  SANDBOX_ORG_ANNOTATION,
  type SandboxSpec,
  type SnapshotRef,
} from "@atelier/spec";
import type { ControlContainer } from "../../control/index.ts";
import type {
  JobRecord,
  JobService,
  RuntimeService,
} from "../../runtime/index.ts";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from "../../shared/errors.ts";
import { OWNER_ID_METADATA } from "../../shared/lib/git-attribution.ts";
import { safeNanoid } from "../../shared/lib/id.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import {
  defaultMemoryMb,
  defaultVcpus,
} from "../../shared/lib/runtime-config.ts";
import type { IdleReaper } from "../idle-reaper.ts";
import { ownedJobMetadata } from "../job-access.ts";
import { requireSourceAccess } from "../sandbox-guard.ts";
import { spawnSurface } from "../spawn-surface.ts";
import {
  type BranchSwitch,
  branchSetupLabel,
  checkoutBranch,
  planBranchSwitch,
  runBranchSetup,
} from "./branch-setup.ts";
import {
  type ToolboxOps,
  toolboxHarness,
  toolboxSurface,
  withToolboxFiles,
} from "./toolbox-ops.ts";

const log = createChildLogger("sandbox-ops");

/** After a wake-up resume ends without the sandbox running (it failed), wait
 * this long before another request may start one: a broken sandbox must not
 * be resumed on every page refresh. */
const RETRY_COOLDOWN_MS = 30_000;

/** How long an operation on a paused sandbox waits for its resume. */
const OP_RESUME_WAIT_MS = 120_000;

/** The caller of an operation (the authenticated user). */
export interface SandboxActor {
  id: string;
  username: string;
  email: string;
}

export interface SandboxOpsDeps {
  runtime: RuntimeService;
  control: ControlContainer;
  jobs: JobService;
  toolboxes: ToolboxOps;
  idle: Pick<IdleReaper, "setKeepAwake">;
  /** The clock of the wake retry cooldown (tests drive it). */
  now?: () => number;
}

/** A short, human label for a sandbox-create job's queue row — the spec's
 * opaque name/workspace metadata when present, else its source. */
function sandboxLabel(req: CreateSandboxRequest): string {
  return (
    req.metadata?.name ??
    req.metadata?.workspace ??
    ("image" in req.source ? req.source.image : req.source.snapshot)
  );
}

/** `repo` is sugar over `prebuild` with an image base (the server picks or
 * bakes the prebuild), or names the branch to switch a prebuild `snapshot`
 * source of that repo to (the caller picked it). With a `prebuild` too, no
 * recipe is unambiguous (400). */
function assertRepoRequest(
  req: CreateSandboxRequest,
  prebuilds: () => readonly PrebuildRecord[],
): void {
  const { repo, source } = req;
  if (!repo) return;
  if (req.prebuild) {
    throw new ValidationError("`repo` cannot be combined with `prebuild`");
  }
  if ("image" in source) return;
  if (!repo.branch?.trim()) {
    throw new ValidationError(
      "`repo` with a snapshot `source` needs the `branch` to switch it to",
    );
  }
  const record = prebuilds().find((p) => p.ref === source.snapshot);
  if (!record || !prebuildRepoFor(record, repo.url)) {
    throw new ValidationError(
      "`repo` with a snapshot `source` needs a prebuild that clones that " +
        "repo (or an image `source` to pick or bake one)",
    );
  }
}

/** A copy of `record` without `key` (undefined stays undefined). */
function withoutKey(
  record: Record<string, string> | undefined,
  key: string,
): Record<string, string> | undefined {
  if (!record) return record;
  const { [key]: _dropped, ...rest } = record;
  return rest;
}

/**
 * The org a spawn runs in (whose secrets and auto-injected toolboxes it
 * gets). An explicit `requested` org must be one the caller belongs to.
 * Absent, it's the default org (`auth.defaultOrg`) when the caller is in it,
 * else their personal org, else their oldest membership, else none (spawn
 * bare).
 */
export function resolveOrgId(
  control: ControlContainer,
  userId: string,
  requested?: string,
): string | undefined {
  if (requested) {
    control.orgMemberService.requireMembership(requested, userId);
    return requested;
  }
  const memberships = control.orgMemberService.getByUserId(userId);
  const defaultOrgId = control.defaultOrg.defaultOrgId();
  if (defaultOrgId && memberships.some((m) => m.orgId === defaultOrgId)) {
    return defaultOrgId;
  }
  const personal = control.userService.getById(userId)?.personalOrgId;
  if (personal && memberships.some((m) => m.orgId === personal)) {
    return personal;
  }
  return [...memberships].sort((a, b) =>
    a.joinedAt.localeCompare(b.joinedAt),
  )[0]?.orgId;
}

/**
 * Wait until `getStatus` says `running`, polling every `pollMs`, up to
 * `timeoutMs`. Resolves true once it runs; false on timeout, or as soon as it
 * cannot get there: the sandbox is gone, settled in `error`/`stopped`, or is
 * `paused` with no resume in flight (the wake-up resume failed).
 */
export async function waitForRunning(
  getStatus: () => string | undefined,
  {
    waking,
    timeoutMs,
    pollMs = 1000,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    now = Date.now,
  }: {
    /** Whether a resume of this sandbox is in flight. */
    waking: () => boolean;
    timeoutMs: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const status = getStatus();
    if (status === "running") return true;
    const pending = status === "creating" || (status === "paused" && waking());
    if (!pending || now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/**
 * Wait for `done` up to `ms`: its value when it settles in time, else
 * `{ settled: false }` (the work carries on). A failure rejects as usual.
 */
export async function settledWithin<T>(
  done: Promise<T>,
  ms: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), ms);
  });
  try {
    return await Promise.race([
      done.then((value) => ({ settled: true as const, value })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class SandboxOps {
  private readonly runtime: RuntimeService;
  private readonly control: ControlContainer;
  private readonly jobs: JobService;
  private readonly toolboxes: ToolboxOps;
  private readonly idle: Pick<IdleReaper, "setKeepAwake">;
  /** When a wake-up resume of a sandbox last ended without the sandbox
   * running (the retry cooldown); cleared once one succeeds. */
  private readonly lastWake = new Map<string, number>();
  private readonly now: () => number;

  constructor(deps: SandboxOpsDeps) {
    this.runtime = deps.runtime;
    this.control = deps.control;
    this.jobs = deps.jobs;
    this.toolboxes = deps.toolboxes;
    this.idle = deps.idle;
    this.now = deps.now ?? Date.now;
  }

  /** The slice of the container the sandbox access guards read. */
  private get guard() {
    return { runtime: this.runtime, control: this.control };
  }

  // ── create / fork ──────────────────────────────────────────────────────

  /**
   * Non-blocking spawn (`POST /v1/sandboxes`): validate, then dispatch a
   * `sandbox-create` job and return it. The id is pre-allocated so the job
   * carries `metadata.sandboxId` — the console navigates straight to the
   * detail page and shows its loading state (the `creating` record lands a
   * moment later, once source resolution completes). Unpooled so a spawn
   * never waits behind a build.
   */
  startCreate(user: SandboxActor, req: CreateSandboxRequest): JobRecord {
    const { options, run } = this.prepareCreate(user, req);
    return this.jobs.dispatch(options, (_signal, onLog) => run(onLog));
  }

  /** `startCreate`, awaited (MCP): resolves once the sandbox is up. */
  create(user: SandboxActor, req: CreateSandboxRequest) {
    const { options, run } = this.prepareCreate(user, req);
    return this.jobs.track(options, (_signal, onLog) => run(onLog));
  }

  private prepareCreate(user: SandboxActor, req: CreateSandboxRequest) {
    // Checked up front for a synchronous 400/403/404, not a failed job.
    assertRepoRequest(req, () => this.runtime.listPrebuilds());
    resolveOrgId(this.control, user.id, req.orgId);
    requireSourceAccess(this.guard, user.id, req.source, req.prebuild?.source);
    const id = safeNanoid();
    const name = req.annotations?.[SANDBOX_NAME_ANNOTATION];
    return {
      options: {
        kind: "sandbox-create" as const,
        target: sandboxLabel(req),
        // `owner` and `name` let `findNamed` match a retry to this job.
        metadata: {
          sandboxId: id,
          owner: user.id,
          ...(name ? { name } : {}),
        },
        unpooled: true,
      },
      run: (onLog: (msg: string) => void) =>
        this.createForUser(user, req, id, onLog),
    };
  }

  /**
   * Resolve the caller's org, apply toolbox auto-inject + explicit selectors,
   * run the enrichment seam, merge toolbox-contributed processes/ports, and
   * boot. The spec the runtime stores keeps its `$secret` refs: they are
   * resolved at every boot.
   */
  private async createForUser(
    user: SandboxActor,
    body: CreateSandboxRequest,
    id: string,
    onProgress: (msg: string) => void,
  ) {
    const { runtime, control } = this;
    // The body is a spec plus the high-level references the caller picked
    // (`toolboxes` selectors, a `prebuild` recipe, a `repo`); strip them so
    // the runtime only ever sees a spec.
    const {
      toolboxes: selectors = [],
      prebuild: bodyPrebuild,
      repo,
      orgId: requestedOrgId,
      resources,
      metadata,
      annotations,
      ...specFields
    } = body;
    // Resolved first: an unauthorized org must fail before any build work.
    const orgId = resolveOrgId(control, user.id, requestedOrgId);
    // `resources` is optional on the request (each field too): fill the gaps
    // from the server's defaults so the runtime always sees a complete spec.
    // The owner-id metadata and the org annotation are server-owned (access
    // rule): enrichment sets the owner and the resolved org is applied below,
    // so a caller-supplied value never survives.
    const callerMetadata = withoutKey(metadata, OWNER_ID_METADATA);
    const callerAnnotations = withoutKey(annotations, SANDBOX_ORG_ANNOTATION);
    let spec: SandboxSpec = {
      ...specFields,
      ...(callerMetadata ? { metadata: callerMetadata } : {}),
      ...(callerAnnotations ? { annotations: callerAnnotations } : {}),
      resources: {
        ...resources,
        vcpus: resources?.vcpus ?? defaultVcpus(),
        memoryMb: resources?.memoryMb ?? defaultMemoryMb(),
      },
    };
    // `repo` with an image source: boot from an existing bake of that branch;
    // else from another bake of the repo, switched to the branch
    // (`branch-setup.ts`); else bake a quick one-repo prebuild below. With a
    // snapshot source (a prebuild of the repo, `assertRepoRequest` checked):
    // boot it, switched to the branch.
    let prebuild = bodyPrebuild;
    let branchSwitch: BranchSwitch | undefined;
    if (repo && "snapshot" in spec.source) {
      const ref = spec.source.snapshot;
      const picked = runtime.listPrebuilds().find((p) => p.ref === ref);
      branchSwitch =
        picked && planBranchSwitch(runtime, picked, repo.url, repo.branch);
    } else if (repo && "image" in spec.source) {
      // Only a bake on the requested base image: another base is another
      // environment.
      const baseImage = spec.source.image;
      const onBase = runtime
        .listPrebuilds()
        .filter(
          (record) =>
            record.spec?.source !== undefined &&
            "image" in record.spec.source &&
            record.spec.source.image === baseImage,
        );
      const baked = findRepoBranchPrebuild(onBase, repo.url, repo.branch);
      const base = baked
        ? undefined
        : findRepoBasePrebuild(onBase, repo.url, repo.branch);
      branchSwitch =
        base && planBranchSwitch(runtime, base, repo.url, repo.branch);
      if (baked) {
        spec = { ...spec, source: { snapshot: baked.ref } };
      } else if (branchSwitch) {
        onProgress(
          `no prebuild of ${branchSwitch.branch}: booting from ` +
            `${branchSwitch.baseRef} and switching to it`,
        );
        spec = { ...spec, source: { snapshot: branchSwitch.baseRef } };
      } else {
        prebuild = buildRepoPrebuildSpec({
          repo: repo.url,
          branch: repo.branch,
          image: spec.source.image,
        });
      }
    }
    // A template built from a prebuild carries the recipe, not a pinned ref:
    // resolve it to the current snapshot (idempotent — a cache hit when
    // unchanged) so an updated prebuild is picked up here.
    const warnings: string[] = [];
    if (prebuild) {
      onProgress("resolving prebuild…");
      const options = {
        githubToken: control.userService.resolveGitHubToken(user.id),
        createdBy: user.id,
      };
      // A cached prebuild is a plain lookup. A bake is a pooled job (in the
      // feed, bounded by `jobs.concurrency`, cancellable); if the fresh build
      // fails the spawn falls back to the recipe's last good one.
      const recipe = prebuild;
      const snapshot: SnapshotRef & { warning?: string } =
        (await runtime.cachedPrebuild(recipe, options)) ??
        (await this.jobs.dispatchAndWait(
          {
            kind: "prebuild",
            target: prebuildJobTarget(recipe),
            metadata: ownedJobMetadata(user.id, recipe.metadata),
          },
          (signal, jobLog) =>
            runtime.prebuildForSpawn(recipe, {
              ...options,
              signal,
              onLog: jobLog,
            }),
        ));
      if (snapshot.warning) {
        warnings.push(snapshot.warning);
        onProgress(`warning: ${snapshot.warning}`);
      }
      spec = { ...spec, source: { snapshot: snapshot.ref } };
    }
    if (selectors.length > 0) onProgress("resolving toolboxes…");
    // The org's auto-inject toolboxes, then the picked ones. Their files are
    // merged into the spec BEFORE enrichment; the spec's own file at the same
    // path wins.
    const { refs: toolboxRefs, applied } = await this.toolboxes.resolveForSpawn(
      { orgId, userId: user.id, selectors, toolsets: spec.toolsets ?? [] },
    );
    const enriched = control.enrichSpec(withToolboxFiles(spec, applied), {
      toolboxHarnessId: toolboxHarness(applied),
      owner: { id: user.id, username: user.username, email: user.email },
    });
    // Dedupe materialized refs (a toolbox can be both auto-injected and
    // picked) so the agent never extracts the same artifact twice.
    const seen = new Set<string>();
    const toolsets = [...toolboxRefs, ...(enriched.toolsets ?? [])].filter(
      (t) => {
        if (seen.has(t.ref)) return false;
        seen.add(t.ref);
        return true;
      },
    );
    // The runtime surface: the prebuild's dev servers, then the toolboxes'
    // tools, then the spec's own (see `spawnSurface` for who wins). A recipe
    // that declares dev servers brings its own; otherwise they're the stored
    // recipe's current ones, so a copied recipe or a pinned snapshot never
    // misses dev servers edited since.
    const declared = prebuild ? runtimeSurfaceOf(prebuild) : {};
    const surface = spawnSurface({
      prebuild:
        declared.processes || declared.ports
          ? declared
          : "snapshot" in spec.source
            ? runtime.prebuildSurface(spec.source.snapshot)
            : undefined,
      toolboxes: toolboxSurface(applied),
      own: enriched,
    });
    if (surface.shadowed.length > 0) {
      log.warn(
        { id, shadowed: surface.shadowed },
        "toolbox entries replace same-name prebuild processes/ports",
      );
    }
    const withToolboxes: SandboxSpec = {
      ...enriched,
      toolsets,
      processes: surface.processes,
      ports: surface.ports,
      ...(orgId
        ? {
            annotations: {
              ...enriched.annotations,
              [SANDBOX_ORG_ANNOTATION]: orgId,
            },
          }
        : {}),
    };
    // A branch switch checks out before any process starts, so neither the
    // dev servers nor an agent ever see the default branch. Its build steps
    // run once the sandbox is up.
    const plan = branchSwitch;
    const checkout = { switched: false };
    const created = await runtime.create(withToolboxes, {
      id,
      onProgress,
      ...(plan
        ? {
            beforeProcesses: async (sandboxId: string) => {
              const warning = await checkoutBranch(
                runtime,
                sandboxId,
                plan,
                onProgress,
              );
              if (warning) {
                warnings.push(warning);
                onProgress(`warning: ${warning}`);
              } else {
                checkout.switched = true;
              }
            },
          }
        : {}),
    });
    if (plan && checkout.switched && plan.build.length > 0) {
      const job = this.startBranchSetup(user.id, id, plan);
      onProgress(`build steps run in the background (job ${job.id})`);
    }
    return warnings.length > 0 ? { ...created, warnings } : created;
  }

  /** Re-run a switched sandbox's build steps in the background: a
   * `sandbox-setup` job on the sandbox (so it holds idle auto-pause), unpooled
   * because it runs in the sandbox itself, not in a build pod. */
  private startBranchSetup(
    owner: string,
    id: string,
    plan: BranchSwitch,
  ): JobRecord {
    return this.jobs.dispatch(
      {
        kind: "sandbox-setup",
        target: branchSetupLabel(plan),
        metadata: { sandboxId: id, owner, repo: plan.url, branch: plan.branch },
        unpooled: true,
      },
      (_signal, log) => runBranchSetup(this.runtime, id, plan, log),
    );
  }

  /** The sandbox's latest `sandbox-setup` job: running while a branch
   * switch's build steps are, then settled with its warnings (if any). */
  latestSetup(id: string): JobRecord | undefined {
    const isSetup = (job: JobRecord) =>
      job.kind === "sandbox-setup" && job.metadata?.sandboxId === id;
    return this.jobs.findActive(isSetup) ?? this.jobs.list(200).find(isSetup);
  }

  /**
   * Fork a sandbox (`POST /v1/sandboxes/:id/fork`): a `sandbox-create` job
   * whose `metadata.sandboxId` is the copy's pre-allocated id, like a spawn.
   * The job snapshots the source, then boots the copy.
   */
  startFork(
    user: SandboxActor,
    sourceId: string,
    body: ForkSandboxRequest,
  ): JobRecord {
    const { options, run } = this.prepareFork(user, sourceId, body);
    return this.jobs.dispatch(options, (_signal, onLog) => run(onLog));
  }

  /** `startFork`, awaited (MCP): resolves once the copy is up. */
  fork(user: SandboxActor, sourceId: string, body: ForkSandboxRequest) {
    const { options, run } = this.prepareFork(user, sourceId, body);
    return this.jobs.track(options, (_signal, onLog) => run(onLog));
  }

  private prepareFork(
    user: SandboxActor,
    sourceId: string,
    body: ForkSandboxRequest,
  ) {
    // No id is handed out that never gets a record: an unknown (404) or
    // non-snapshottable (409) source is a plain error, not a failed job.
    this.runtime.assertSnapshottable(sourceId);
    const id = safeNanoid();
    return {
      options: {
        kind: "sandbox-create" as const,
        target: body.name ?? `fork of ${sourceId}`,
        metadata: { sandboxId: id, forkOf: sourceId, owner: user.id },
        unpooled: true,
      },
      // Both jobs run the body synchronously up to its first await, and the
      // runtime registers the copy's `creating` record before that: the id
      // in the 202 resolves immediately.
      run: (onLog: (msg: string) => void) =>
        this.forkForUser(user, sourceId, body, id, onLog),
    };
  }

  /**
   * Snapshot the source and boot a copy owned by the CALLER. The runtime only
   * does the mechanism; the copy's spec is derived through control — the
   * source owner's annotations and metadata are replaced by the caller's
   * (`atelier.dev/owner-id` is forced, an echoed value is overridden), and
   * git credentials follow the new owner at boot. The copy keeps the source's
   * org annotation, so its `$secret` refs resolve in the same org. Authorizing
   * access to the source is the caller's job (the sandbox-access guard).
   */
  private forkForUser(
    user: SandboxActor,
    sourceId: string,
    body: ForkSandboxRequest,
    id: string,
    onProgress: (msg: string) => void,
  ) {
    const { runtime, control } = this;
    const name = body.name?.trim() || undefined;
    // The copy's labels until `derive` runs (or if it fails): the caller as
    // owner, the source's org only, never the source owner's.
    const org =
      runtime.getLabels(sourceId)?.annotations[SANDBOX_ORG_ANNOTATION];
    return runtime.fork(
      sourceId,
      {
        name,
        initial: {
          metadata: { [OWNER_ID_METADATA]: user.id },
          annotations: {
            ...(org ? { [SANDBOX_ORG_ANNOTATION]: org } : {}),
            ...(name ? { [SANDBOX_NAME_ANNOTATION]: name } : {}),
          },
        },
        derive: (sourceSpec) => ({
          spec: control.reattributeSpec(
            sourceSpec,
            { id: user.id, username: user.username, email: user.email },
            body.metadata,
          ),
        }),
      },
      { id, onProgress },
    );
  }

  /**
   * The caller's sandbox called `name` (the `atelier.dev/name` annotation),
   * or the create job still booting it: what makes a retried `create_sandbox`
   * return the same sandbox instead of a duplicate.
   */
  findNamed(
    userId: string,
    name: string,
  ): { id: string; status: string; jobId?: string } | undefined {
    const existing = this.runtime
      .list()
      .find(
        (s) =>
          s.annotations?.[SANDBOX_NAME_ANNOTATION] === name &&
          s.metadata?.[OWNER_ID_METADATA] === userId,
      );
    if (existing) return { id: existing.id, status: existing.status };
    const job = this.jobs.findActive(
      (j) =>
        j.kind === "sandbox-create" &&
        j.metadata?.owner === userId &&
        j.metadata?.name === name,
    );
    const id = job?.metadata?.sandboxId;
    return job && id ? { id, status: "creating", jobId: job.id } : undefined;
  }

  /** The caller's create job that has not landed its sandbox record yet:
   * lets `get_sandbox` answer `creating` instead of "not found" in the
   * first moments after `create_sandbox`. */
  pendingCreate(userId: string, id: string): JobRecord | undefined {
    return this.jobs.findActive(
      (j) =>
        j.kind === "sandbox-create" &&
        j.metadata?.owner === userId &&
        j.metadata?.sandboxId === id,
    );
  }

  // ── lifecycle ──────────────────────────────────────────────────────────
  // Awaited, unpooled jobs: the caller gets the resource inline and the op
  // never queues behind a build.

  // `owner` is the user who asked, recorded on the job so it stays in their
  // feed (the sandbox access rule scopes the rest).
  pause(id: string, owner?: string): Promise<SnapshotRef> {
    return this.jobs.track(
      {
        kind: "sandbox-pause",
        target: id,
        metadata: ownedJobMetadata(owner),
      },
      () => this.runtime.pause(id),
    );
  }

  /** Resume a paused (or errored) sandbox. `body` may add files/env. */
  resume(id: string, body: ResumeRequest = {}, owner?: string) {
    // Checked before the job opens: an unknown id is a plain 404.
    if (this.runtime.getStatus(id) === undefined) {
      throw new NotFoundError("Sandbox", id);
    }
    return this.jobs.track(
      {
        kind: "sandbox-resume",
        target: id,
        metadata: ownedJobMetadata(owner),
      },
      () => this.runtime.resume(id, body),
    );
  }

  snapshot(id: string, owner?: string): Promise<SnapshotRef> {
    return this.jobs.track(
      {
        kind: "sandbox-snapshot",
        target: id,
        metadata: ownedJobMetadata(owner),
      },
      () => this.runtime.snapshot(id),
    );
  }

  destroy(id: string, owner?: string): Promise<void> {
    return this.jobs.track(
      {
        kind: "sandbox-destroy",
        target: id,
        metadata: ownedJobMetadata(owner),
      },
      () => this.runtime.destroy(id),
    );
  }

  /**
   * pause / resume / snapshot as a job the caller may leave running (MCP):
   * `done` settles with the op's result; the job keeps going whether or not
   * anyone awaits it. The job body is started synchronously, so `done` is set
   * when `dispatch` returns.
   */
  startLifecycle(
    action: "pause" | "resume" | "snapshot",
    id: string,
    owner?: string,
  ): { job: JobRecord; done: Promise<unknown> } {
    if (this.runtime.getStatus(id) === undefined) {
      throw new NotFoundError("Sandbox", id);
    }
    let done: Promise<unknown> = Promise.resolve();
    const job = this.jobs.dispatch(
      {
        kind: `sandbox-${action}`,
        target: id,
        metadata: ownedJobMetadata(owner),
        unpooled: true,
      },
      () => {
        done =
          action === "pause"
            ? this.runtime.pause(id)
            : action === "resume"
              ? this.runtime.resume(id, {})
              : this.runtime.snapshot(id);
        return done;
      },
    );
    return { job, done };
  }

  /** Bake a prebuild as a pooled job (`POST /v1/prebuilds`, MCP
   * `manage_prebuilds`). The GitHub token is resolved now, in request scope,
   * for cloning private repos; it is never baked into the shared artifact. */
  startPrebuild(
    user: SandboxActor,
    spec: PrebuildSpec,
    options: { force?: boolean } = {},
  ): JobRecord {
    requireSourceAccess(this.guard, user.id, spec.source);
    const githubToken = this.control.userService.resolveGitHubToken(user.id);
    const surfaceAdmin = this.control.defaultOrg.isServerAdmin(user.id);
    return this.jobs.dispatch(
      {
        kind: "prebuild",
        target: prebuildJobTarget(spec),
        metadata: ownedJobMetadata(user.id, spec.metadata),
      },
      (signal, log) =>
        this.runtime.prebuild(spec, {
          force: options.force === true,
          githubToken,
          createdBy: user.id,
          signal,
          onLog: log,
          // The explicit create: a declared surface is saved on a cache hit,
          // by the recipe's creator or a server admin only.
          saveSurface: true,
          surfaceAdmin,
        }),
    );
  }

  /** Exempt the sandbox from idle auto-pause until `until` (`null` clears),
   * within the operator's bounds. Returns the stored value. An instant
   * annotation write, so no job. */
  keepAwake(id: string, until: string | null): string | undefined {
    return this.idle.setKeepAwake(id, until);
  }

  // ── wake / auto-resume ─────────────────────────────────────────────────

  /** Whether a resume of the sandbox is running right now. */
  isResuming(id: string): boolean {
    return (
      this.jobs.findActive(
        (job) => job.kind === "sandbox-resume" && job.target === id,
      ) !== undefined
    );
  }

  /**
   * Make sure a paused sandbox is resuming (not awaited). Returns whether the
   * sandbox is paused, so the caller should answer "waking up": a resume is
   * already running, was just started, or failed recently and is cooling
   * down. False for any other status, which needs no wake-up. Concurrent
   * callers share one resume job.
   */
  wake(id: string): boolean {
    if (this.runtime.getStatus(id) !== "paused") return false;
    if (this.isResuming(id)) return true;
    const failed = this.lastWake.get(id);
    if (failed !== undefined && this.now() - failed < RETRY_COOLDOWN_MS) {
      return true;
    }
    this.jobs.dispatch(
      {
        kind: "sandbox-resume",
        target: id,
        metadata: { trigger: "wake" },
        unpooled: true,
      },
      async () => {
        // The cooldown starts when the resume ENDS without the sandbox
        // running, never when it starts: a wake that worked must not stop
        // the next one after the sandbox is paused again.
        try {
          await this.runtime.resume(id);
        } finally {
          if (this.runtime.getStatus(id) === "running")
            this.lastWake.delete(id);
          else this.lastWake.set(id, this.now());
        }
      },
    );
    return true;
  }

  /**
   * Make sure the sandbox is running before an operation that needs its
   * agent: a paused one is resumed (as a job in the feed) and waited for, up
   * to `timeoutMs`. Any other status is left to the operation itself, so an
   * `error` sandbox stays an error. Throws `ConflictError` when the resume
   * does not bring it up in time (or failed).
   */
  async ensureRunning(
    id: string,
    timeoutMs: number = OP_RESUME_WAIT_MS,
  ): Promise<void> {
    if (this.runtime.getStatus(id) !== "paused") return;
    log.info({ id }, "operation on a paused sandbox; resuming it first");
    this.wake(id);
    const running = await waitForRunning(() => this.runtime.getStatus(id), {
      waking: () => this.isResuming(id),
      timeoutMs,
    });
    if (!running) {
      throw new ConflictError(
        `Sandbox ${id} was paused and did not resume (status: ${this.runtime.getStatus(id) ?? "gone"})`,
      );
    }
  }

  // ── live operations (resume a paused sandbox first) ────────────────────

  async exec(id: string, req: ExecRequest) {
    await this.ensureRunning(id);
    return this.runtime.exec(id, req);
  }

  async patchFiles(id: string, files: PatchFilesRequest) {
    await this.ensureRunning(id);
    return this.runtime.patchFiles(id, files);
  }

  async processAction(id: string, name: string, action: "start" | "stop") {
    await this.ensureRunning(id);
    return this.runtime.processAction(id, name, action);
  }

  async processLogs(id: string, name: string, offset?: number, limit?: number) {
    await this.ensureRunning(id);
    return this.runtime.processLogs(id, name, offset, limit);
  }
}
