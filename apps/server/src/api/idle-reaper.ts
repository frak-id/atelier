/**
 * The idle reaper (docs/proposals/sandbox-idle-autopause.md §5): every minute
 * it polls each running sandbox's agent, evaluates the operator's idle rule,
 * and in `enforce` mode pauses the sandboxes nobody used for `minutes`. It
 * also serves the activity view and the `idle` decoration of list rows.
 *
 * Lives in api/ because it composes all three modules: runtime (activity
 * clocks, pause), control (the rule) and sessions (ACP turns and permission
 * requests in flight).
 */
import {
  SANDBOX_IDLE_PAUSED_ANNOTATION,
  SANDBOX_KEEP_AWAKE_ANNOTATION,
  type SandboxActivity,
  type SandboxIdleSummary,
  type SandboxSummary,
} from "@atelier/spec";
import {
  evaluateIdle,
  type IdleEvaluation,
  type IdlePolicyService,
  type IdleRule,
} from "../control/index.ts";
import type { JobService, RuntimeService } from "../runtime/index.ts";
import type { AgentDispatch } from "../sessions/index.ts";
import { NotFoundError } from "../shared/errors.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("idle-reaper");

/** Agents polled in parallel per tick. */
const POLL_CONCURRENCY = 8;

export interface IdleReaperDeps {
  runtime: Pick<
    RuntimeService,
    | "list"
    | "getStatus"
    | "getLabels"
    | "activityRecord"
    | "hasPendingOp"
    | "pollActivity"
    | "pause"
    | "setAnnotation"
  >;
  jobs: Pick<JobService, "track" | "hasActiveFor">;
  dispatch: Pick<AgentDispatch, "workFor">;
  policy: Pick<IdlePolicyService, "rule" | "parseKeepAwake">;
  now?: () => number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** `{ [key]: iso(ms) }` when `ms` is set, else nothing (for spreading). */
const isoField = <K extends string>(key: K, ms: number | undefined) =>
  ms === undefined ? {} : ({ [key]: iso(ms) } as Record<K, string>);

/** Run `fn` over `items`, at most `limit` at a time. */
async function forEachLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}

export class IdleReaper {
  private readonly now: () => number;
  /** Sandboxes already logged as due in `observe` mode, so the log says it
   * once per idle episode instead of every minute. */
  private readonly loggedDue = new Set<string>();

  constructor(private readonly deps: IdleReaperDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** One pass over every running sandbox. Never throws for one sandbox's
   * failure (each is caught and logged). */
  async tick(): Promise<void> {
    const rule = this.deps.policy.rule();
    const sandboxes = this.deps.runtime.list();
    this.clearStaleAnnotations(sandboxes);
    if (rule.mode === "off") {
      this.loggedDue.clear();
      return;
    }
    const running = sandboxes.filter((s) => s.status === "running");
    await forEachLimit(running, POLL_CONCURRENCY, async (s) => {
      try {
        await this.reap(s.id, rule);
      } catch (err) {
        log.warn({ id: s.id, err }, "idle check failed");
      }
    });
  }

  /** The rule carries the thresholds (`ActivityThresholds`) itself. */
  private poll(id: string, rule: IdleRule) {
    return this.deps.runtime.pollActivity(id, rule);
  }

  private async reap(id: string, rule: IdleRule): Promise<void> {
    await this.poll(id, rule);
    let evaluation = this.evaluate(id, rule);
    if (evaluation?.state !== "due") {
      this.loggedDue.delete(id);
      return;
    }
    if (!evaluation.shouldPause) {
      if (!this.loggedDue.has(id)) {
        this.loggedDue.add(id);
        log.info(
          { id, lastActiveAt: iso(evaluation.lastActiveAt) },
          "sandbox idle; would be paused (observe mode)",
        );
      }
      return;
    }
    // Someone may have come back while this tick ran: look again right
    // before acting.
    await this.poll(id, rule);
    evaluation = this.evaluate(id, rule);
    if (!evaluation?.shouldPause) return;
    this.loggedDue.delete(id);
    log.info(
      {
        id,
        lastActiveAt: iso(evaluation.lastActiveAt),
        idleMinutes: rule.minutes,
      },
      "pausing idle sandbox",
    );
    await this.deps.jobs.track(
      { kind: "sandbox-pause", target: id, metadata: { reason: "idle" } },
      () => this.deps.runtime.pause(id),
    );
    this.deps.runtime.setAnnotation(
      id,
      SANDBOX_IDLE_PAUSED_ANNOTATION,
      iso(this.now()),
    );
  }

  /** Drop annotations that no longer mean anything: the idle-pause mark of
   * a sandbox running again, and an expired keep-awake. */
  private clearStaleAnnotations(rows: SandboxSummary[]): void {
    for (const row of rows) {
      const annotations = row.annotations ?? {};
      if (
        row.status !== "paused" &&
        annotations[SANDBOX_IDLE_PAUSED_ANNOTATION] !== undefined
      ) {
        this.deps.runtime.setAnnotation(
          row.id,
          SANDBOX_IDLE_PAUSED_ANNOTATION,
          undefined,
        );
      }
      const keepAwake = annotations[SANDBOX_KEEP_AWAKE_ANNOTATION];
      const until = keepAwake ? Date.parse(keepAwake) : Number.NaN;
      if (Number.isFinite(until) && until <= this.now()) {
        this.deps.runtime.setAnnotation(
          row.id,
          SANDBOX_KEEP_AWAKE_ANNOTATION,
          undefined,
        );
      }
    }
  }

  /** The rule applied to one sandbox right now, or undefined when it is
   * unknown. */
  evaluate(
    id: string,
    rule: IdleRule = this.deps.policy.rule(),
  ): IdleEvaluation | undefined {
    const status = this.deps.runtime.getStatus(id);
    if (!status) return undefined;
    const record = this.deps.runtime.activityRecord(id);
    return evaluateIdle(rule, {
      status,
      now: this.now(),
      since: record.since,
      last: record.last,
      agentReporting: record.agent?.reporting,
      keepAwakeUntil:
        this.deps.runtime.getLabels(id)?.annotations[
          SANDBOX_KEEP_AWAKE_ANNOTATION
        ],
      work: this.deps.dispatch.workFor(id),
      jobActive: this.deps.jobs.hasActiveFor(id),
      opPending: this.deps.runtime.hasPendingOp(id),
    });
  }

  /** The idle state of one sandbox: undefined when the rules are off or it
   * isn't running (only a running sandbox has an idle clock). */
  summary(
    id: string,
    rule: IdleRule = this.deps.policy.rule(),
  ): SandboxIdleSummary | undefined {
    if (rule.mode === "off") return undefined;
    const evaluation = this.evaluate(id, rule);
    if (!evaluation || evaluation.state === "not-running") return undefined;
    return {
      mode: rule.mode,
      state: evaluation.state,
      lastActiveAt: iso(evaluation.lastActiveAt),
      ...isoField("pausesAt", evaluation.pausesAt),
    };
  }

  /** Add the `idle` decoration to running sandboxes' list rows. */
  decorate(rows: SandboxSummary[]): SandboxSummary[] {
    const rule = this.deps.policy.rule();
    if (rule.mode === "off") return rows;
    return rows.map((row) => {
      const idle = row.status === "running" && this.summary(row.id, rule);
      return idle ? { ...row, idle } : row;
    });
  }

  /** `GET /v1/sandboxes/:id/activity`. Served from the last poll: reading it
   * never calls the agent. */
  view(id: string): SandboxActivity {
    const rule = this.deps.policy.rule();
    const evaluation = this.evaluate(id, rule);
    if (!evaluation) throw new NotFoundError("Sandbox", id);
    const record = this.deps.runtime.activityRecord(id);
    const annotations = this.deps.runtime.getLabels(id)?.annotations ?? {};
    const keepAwake = annotations[SANDBOX_KEEP_AWAKE_ANNOTATION];
    const idlePausedAt = annotations[SANDBOX_IDLE_PAUSED_ANNOTATION];
    const report = record.agent?.reporting ? record.agent.report : undefined;
    const signals: SandboxActivity["signals"] = {};
    for (const [signal, at] of Object.entries(record.last)) {
      signals[signal as keyof typeof signals] = iso(at);
    }
    return {
      sandboxId: id,
      mode: rule.mode,
      state: evaluation.state,
      idleMinutes: rule.minutes,
      lastActiveAt: iso(evaluation.lastActiveAt),
      ...isoField("pausesAt", evaluation.pausesAt),
      blockers: evaluation.blockers,
      ...(keepAwake && evaluation.blockers.includes("keep-awake")
        ? { keepAwakeUntil: keepAwake }
        : {}),
      maxKeepAwakeHours: rule.maxKeepAwakeHours,
      ...(idlePausedAt ? { idlePausedAt } : {}),
      counted: evaluation.counted,
      signals,
      thresholds: {
        networkMinBytesPerMinute: rule.networkMinBytesPerMinute,
        cpuMinMillicores: rule.cpuMinMillicores,
      },
      agent: {
        reporting: record.agent?.reporting ?? false,
        ...isoField("polledAt", record.agent?.polledAt),
        ...(report
          ? { network: report.network, files: report.files, cpu: report.cpu }
          : {}),
      },
      minutes: (report?.buckets ?? []).map((b) => ({
        start: iso(b.startMs),
        receivedBytes: b.receivedBytes,
        sentBytes: b.sentBytes,
        fileWrites: b.fileWrites,
        cpuMs: b.cpuMs,
      })),
    };
  }

  /**
   * Set or clear a sandbox's keep-awake (`PATCH /v1/sandboxes/:id`
   * `keepAwakeUntil`, the MCP `keep_awake` action), within the operator's
   * bounds. Returns the stored value (undefined when cleared).
   */
  setKeepAwake(id: string, value: string | null): string | undefined {
    if (!this.deps.runtime.getStatus(id))
      throw new NotFoundError("Sandbox", id);
    const normalized = this.deps.policy.parseKeepAwake(value, this.now());
    this.deps.runtime.setAnnotation(
      id,
      SANDBOX_KEEP_AWAKE_ANNOTATION,
      normalized,
    );
    return normalized;
  }
}
