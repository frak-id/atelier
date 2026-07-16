/**
 * `JobService` — the durable, observable lifecycle around the runtime's
 * long-running operations. It is MECHANISM, not policy: it knows how to run a
 * promise, track it in a `jobs` row, stream transitions, bound parallelism,
 * and cancel — never what the work is. The api/ seam dispatches work here so a
 * client can `202` + subscribe to `/v1/jobs/events` instead of holding a
 * blocking request open. Internal callers (spawn-time toolbox builds) still
 * call `RuntimeService` directly and never create a job.
 *
 * Two entry points:
 *  - `dispatch(fn)` — POOLED, fire-and-forget: the expensive throwaway-pod
 *    builds (prebuild/toolset). Beyond `concurrency` in flight they sit
 *    `queued` and start as slots free. Returns the row synchronously.
 *  - `track(fn)` — UNPOOLED, awaited: sandbox lifecycle ops (create/pause/…)
 *    that must return their result inline. Recorded in the feed for
 *    visibility, but never gated by the pool and never queued behind builds.
 *
 * Global, no identity scope (the runtime carries no identity FK — the whole
 * queue is one shared view for now).
 *
 * Durability with one quirk (by design): the in-flight promise, its
 * `AbortController`, and the waiting queue live only in this process. A
 * crash/restart kills them, so `reconcileOnStartup()` sweeps every
 * non-terminal row (`queued`/`running`) to `failed`/"rebooted" at boot — a
 * reboot would fail almost everything anyway, so we say so instead of leaving
 * ghosts.
 */
import { ConflictError, NotFoundError } from "../shared/errors.ts";
import { safeNanoid } from "../shared/lib/id.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import {
  InMemoryJobStore,
  isJobTerminal,
  type JobKind,
  type JobRecord,
  type JobStore,
} from "./store.ts";

const log = createChildLogger("jobs");

export interface JobDispatchOptions {
  kind: JobKind;
  /** Human-facing label for the queue UI (prebuild/toolset/sandbox name). */
  target?: string;
  /** Opaque display context (repo, slug, sandbox id, …). */
  metadata?: Record<string, string>;
}

/** Raised by a job body when it observes its own `AbortSignal` and bails —
 * lets `JobService` record `canceled` instead of `failed`. */
export class JobCanceledError extends Error {
  constructor() {
    super("Job canceled");
    this.name = "JobCanceledError";
  }
}

export interface JobServiceDeps {
  store?: JobStore;
  /** Max POOLED jobs in flight at once (default 4). `track` jobs bypass it. */
  concurrency?: number;
}

type JobFn = (signal: AbortSignal) => Promise<unknown>;
type JobListener = (job: JobRecord) => void;

export class JobService {
  private readonly store: JobStore;
  private readonly concurrency: number;
  /** Live cancellation handles for every RUNNING job (pooled or tracked),
   * keyed by id. Populated when a job starts, deleted when it settles. */
  private readonly controllers = new Map<string, AbortController>();
  /** Pooled jobs accepted but not yet started (no slot free), FIFO. */
  private readonly waiting: Array<{ id: string; fn: JobFn }> = [];
  /** Ids of pooled jobs currently running — the pool's occupancy (tracked
   * jobs are deliberately excluded, so they never consume build slots). */
  private readonly pooledInFlight = new Set<string>();
  private readonly listeners = new Set<JobListener>();

  constructor(deps: JobServiceDeps = {}) {
    this.store = deps.store ?? new InMemoryJobStore();
    this.concurrency = Math.max(1, deps.concurrency ?? 4);
  }

  list(limit?: number): JobRecord[] {
    return this.store.list(limit);
  }

  /**
   * Retention sweep: delete terminal rows older than `olderThanMs` (the `jobs`
   * table is otherwise append-only — one row per op forever). Non-terminal
   * rows are never touched. Returns how many were removed. Wired to a cron in
   * the bootstrap, mirroring `pruneUnusedPrebuilds`/`pruneToolboxVersions`.
   */
  pruneTerminal(olderThanMs: number): number {
    const before = new Date(Date.now() - olderThanMs).toISOString();
    const removed = this.store.deleteTerminalBefore(before);
    if (removed > 0) log.info({ removed }, "pruned old terminal jobs");
    return removed;
  }

  get(id: string): JobRecord {
    const job = this.store.get(id);
    if (!job) throw new NotFoundError("Job", id);
    return job;
  }

  /**
   * POOLED dispatch. Creates a `queued` row, then starts it immediately if a
   * concurrency slot is free (else it waits). Returns the row synchronously —
   * its status reflects whether it started (`running`) or is waiting
   * (`queued`). The promise settles the job and emits every transition; `fn`
   * gets an `AbortSignal` for cooperative cancellation (else cancel is
   * best-effort). Use for the expensive throwaway-pod builds.
   */
  dispatch(options: JobDispatchOptions, fn: JobFn): JobRecord {
    const job = this.createRow(options, "queued");
    this.emit(job);
    this.waiting.push({ id: job.id, fn });
    this.pump();
    return this.store.get(job.id) ?? job;
  }

  /**
   * UNPOOLED, awaited run. Records a job (for feed visibility), runs `fn` to
   * completion, and returns its result — re-throwing on failure so the route
   * surfaces the error exactly as a direct call would. Never queues, never
   * counts against the pool. Use for sandbox lifecycle ops that must return
   * their resource inline.
   */
  async track<T>(
    options: JobDispatchOptions,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const job = this.createRow(options, "running");
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    this.emit(job);
    try {
      const result = await fn(controller.signal);
      this.settle(job.id, { status: "succeeded", result });
      return result;
    } catch (err) {
      const canceled =
        controller.signal.aborted || err instanceof JobCanceledError;
      this.settle(job.id, {
        status: canceled ? "canceled" : "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Cancel a non-terminal job:
   *  - `queued`: pulled from the wait list and settled `canceled` before it
   *    ever runs (no side effects to unwind).
   *  - `running` POOLED build (prebuild/toolset): its `AbortSignal` is aborted.
   *    The op observes it at a checkpoint (or its in-flight agent call aborts),
   *    unwinds — tearing its throwaway pod down — and settles itself
   *    `canceled` via the natural catch. We deliberately DON'T settle here or
   *    free the pool slot early: the slot is released only when the op
   *    actually unwinds, so a canceled build never over-subscribes the pool.
   *    The row stays `running` for the brief unwind window, then flips.
   *  - `running` TRACKED lifecycle op (`sandbox-*`): NOT cancellable — these
   *    are awaited by their route and mutate shared state (a half-canceled
   *    `sandbox-destroy` is dangerous), so cancelling one is a `409`.
   *  - terminal: `409`.
   */
  cancel(id: string): JobRecord {
    const job = this.get(id);
    if (job.status === "queued") {
      const idx = this.waiting.findIndex((w) => w.id === id);
      if (idx !== -1) this.waiting.splice(idx, 1);
      return (
        this.settle(id, { status: "canceled", error: "Canceled by user" }) ??
        job
      );
    }
    if (job.status === "running" && this.pooledInFlight.has(id)) {
      // Cooperative: abort and let the op unwind + settle itself `canceled`.
      this.controllers.get(id)?.abort();
      return this.get(id);
    }
    throw new ConflictError(
      `Job ${id} is ${job.status} and cannot be canceled`,
    );
  }

  /**
   * Boot sweep: every non-terminal row is a ghost (its promise + queue entry
   * died with the previous process), so fail it with a "rebooted" reason.
   * Synchronous, called once before the HTTP listener starts — mirrors the
   * `RuntimeService`/`ImageBuilderService` zombie sweeps.
   */
  reconcileOnStartup(): void {
    const ids = this.store.failActive(
      "Interrupted by a server restart (rebooted).",
    );
    if (ids.length > 0) {
      log.warn({ count: ids.length }, "swept active jobs after restart");
    }
  }

  /**
   * Subscribe to job transitions until `signal` aborts. Replays the currently
   * non-terminal jobs first (so a late subscriber sees in-flight + queued
   * work — the full history comes from `GET /v1/jobs`, so we don't replay the
   * unbounded settled backlog on every connect), then streams every
   * subsequent transition. Mirrors the session event stream's push model,
   * consumed by the `/v1/jobs/events` SSE route.
   */
  subscribe(signal: AbortSignal, listener: JobListener): void {
    for (const job of this.store.list()) {
      if (!isJobTerminal(job.status)) listener(job);
    }
    this.listeners.add(listener);
    signal.addEventListener("abort", () => this.listeners.delete(listener), {
      once: true,
    });
  }

  private createRow(options: JobDispatchOptions, status: JobRecord["status"]) {
    const now = new Date().toISOString();
    const job: JobRecord = {
      id: safeNanoid(),
      kind: options.kind,
      status,
      target: options.target,
      metadata: options.metadata,
      createdAt: now,
      updatedAt: now,
    };
    this.store.create(job);
    return job;
  }

  /** Start as many waiting pooled jobs as free slots allow (FIFO). */
  private pump(): void {
    while (
      this.pooledInFlight.size < this.concurrency &&
      this.waiting.length > 0
    ) {
      const next = this.waiting.shift();
      if (next) this.beginPooled(next.id, next.fn);
    }
  }

  private beginPooled(id: string, fn: JobFn): void {
    const job = this.store.get(id);
    // Canceled while it sat in the queue — skip (cancel already settled it).
    if (!job || job.status !== "queued") return;
    this.pooledInFlight.add(id);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const updated = this.store.update(id, { status: "running" });
    if (updated) this.emit(updated);
    void fn(controller.signal)
      .then((result) => this.settle(id, { status: "succeeded", result }))
      .catch((err) => {
        const canceled =
          controller.signal.aborted || err instanceof JobCanceledError;
        this.settle(id, {
          status: canceled ? "canceled" : "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  private settle(id: string, patch: Partial<JobRecord>): JobRecord | undefined {
    const existing = this.store.get(id);
    // First terminal state wins (cancel racing natural completion, double
    // settle from track's catch after cancel, …).
    if (!existing || isJobTerminal(existing.status)) return existing;
    const updated = this.store.update(id, {
      ...patch,
      finishedAt: new Date().toISOString(),
    });
    this.controllers.delete(id);
    this.pooledInFlight.delete(id);
    if (updated) this.emit(updated);
    // A freed slot (or a canceled queued job) may let the next one start.
    this.pump();
    return updated;
  }

  private emit(job: JobRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(job);
      } catch (err) {
        log.warn({ err, jobId: job.id }, "job listener threw");
      }
    }
  }
}
