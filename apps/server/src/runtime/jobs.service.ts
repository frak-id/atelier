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
  /** Skip the concurrency pool: start immediately, don't queue, don't count
   * against the build slots. Fire-and-forget like a normal dispatch (returns
   * the row, doesn't await) but with `track`-style non-gating — for latency-
   * sensitive ops (sandbox spawn) that must never wait behind a build. */
  unpooled?: boolean;
}

/** How many jobs' log buffers we keep in memory at once (LRU-evicted). Logs
 * are ephemeral (never persisted) — a tail for live/recent jobs, not history. */
const MAX_LOG_JOBS = 200;
/** Max log lines retained per job (a ring buffer tail, like image builds). */
const MAX_LOG_LINES = 1000;

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
  /** Max POOLED jobs in flight at once (default 4). `track` jobs bypass it.
   * A function is read on every pump so a live config edit re-bounds the pool
   * (a lowered limit just stops starting new jobs; in-flight ones finish). */
  concurrency?: number | (() => number);
}

/** Append a line/chunk to the job's live log (see `dispatch`/`track`). */
export type JobLog = (chunk: string) => void;
type JobFn = (signal: AbortSignal, log: JobLog) => Promise<unknown>;
type JobListener = (job: JobRecord) => void;

export class JobService {
  private readonly store: JobStore;
  private readonly concurrency: () => number;
  /** Live cancellation handles for every RUNNING job (pooled or tracked),
   * keyed by id. Populated when a job starts, deleted when it settles. */
  private readonly controllers = new Map<string, AbortController>();
  /** Ephemeral per-job log tails (in-memory only, LRU-capped). */
  private readonly logs = new Map<string, string[]>();
  /** Pooled jobs accepted but not yet started (no slot free), FIFO. */
  private readonly waiting: Array<{ id: string; fn: JobFn }> = [];
  /** Ids of pooled jobs currently running — the pool's occupancy (tracked
   * jobs are deliberately excluded, so they never consume build slots). */
  private readonly pooledInFlight = new Set<string>();
  private readonly listeners = new Set<JobListener>();

  constructor(deps: JobServiceDeps = {}) {
    this.store = deps.store ?? new InMemoryJobStore();
    const c = deps.concurrency;
    const read = typeof c === "function" ? c : () => c ?? 4;
    this.concurrency = () => Math.max(1, read());
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
    // Unpooled: start now, like `track` but fire-and-forget — never queues,
    // never counts against the build slots. For latency-sensitive ops.
    if (options.unpooled) {
      const job = this.createRow(options, "running");
      this.emit(job);
      this.run(job.id, fn, { pooled: false });
      return this.store.get(job.id) ?? job;
    }
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
    fn: (signal: AbortSignal, log: JobLog) => Promise<T>,
  ): Promise<T> {
    const job = this.createRow(options, "running");
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    this.emit(job);
    try {
      const result = await fn(controller.signal, this.logSink(job.id));
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

  /** Read a job's live log tail (empty string if none). Paired with the
   * `GET /v1/jobs/:id/logs` endpoint the console polls, mirroring image logs. */
  getLog(id: string): string {
    return (this.logs.get(id) ?? []).join("\n");
  }

  /** A bound log sink for one job: appends chunks (split into lines) to its
   * ring-buffer tail, evicting the least-recently-WRITTEN job past
   * `MAX_LOG_JOBS`. Every write re-inserts the job at the tail of the Map (a
   * true LRU-by-write), so a still-active job is never evicted ahead of an
   * idle/settled one, and settled jobs age out naturally as new logs arrive. */
  private logSink(id: string): JobLog {
    return (chunk: string) => {
      let lines = this.logs.get(id);
      if (lines) {
        // Touch: move to the tail (most-recently-written) for LRU ordering.
        this.logs.delete(id);
      } else {
        if (this.logs.size >= MAX_LOG_JOBS) {
          const oldest = this.logs.keys().next().value;
          if (oldest !== undefined) this.logs.delete(oldest);
        }
        lines = [];
      }
      this.logs.set(id, lines);
      for (const line of chunk.split("\n")) lines.push(line);
      if (lines.length > MAX_LOG_LINES) {
        lines.splice(0, lines.length - MAX_LOG_LINES);
      }
    };
  }

  /**
   * Run a job's body with cancellation + logging wired, settling it on the
   * first terminal outcome. Shared by pooled starts and unpooled dispatch;
   * `pooled` toggles the concurrency-slot bookkeeping.
   */
  private run(id: string, fn: JobFn, { pooled }: { pooled: boolean }): void {
    if (pooled) this.pooledInFlight.add(id);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    void fn(controller.signal, this.logSink(id))
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
      this.pooledInFlight.size < this.concurrency() &&
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
    const updated = this.store.update(id, { status: "running" });
    if (updated) this.emit(updated);
    this.run(id, fn, { pooled: true });
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
