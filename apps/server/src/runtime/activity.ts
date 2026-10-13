/**
 * Sandbox activity recorder (docs/proposals/sandbox-idle-autopause.md §3,
 * §5). MECHANISM: it remembers when each signal was last seen per sandbox and
 * folds in the in-pod agent's `GET /activity` report. It never decides
 * anything: the thresholds a minute must reach come in as arguments, and the
 * idle rules live in control/ (`IdlePolicyService`).
 *
 * In memory on purpose. After a server restart every clock starts at the
 * restart (`since`), so a restart can delay a pause but never cause an early
 * one; the agent's 60-minute window refills the network/file history on the
 * first poll.
 */
import type { ActivitySignal } from "@atelier/spec";

/** One minute bucket as the agent reports it (`apps/agent/src/activity`). */
interface AgentActivityBucket {
  startMs: number;
  receivedBytes: number;
  sentBytes: number;
  fileWrites: number;
  cpuMs: number;
}

/** The agent's `GET /activity` body. */
export interface AgentActivityReport {
  nowMs: number;
  bootedAtMs: number;
  bucketSeconds: number;
  network: "pending" | "netdev" | "unavailable";
  files: "pending" | "fanotify" | "unavailable";
  cpu: "pending" | "cgroup2" | "procstat" | "unavailable";
  buckets: AgentActivityBucket[];
}

/** What a minute must reach to count as activity (policy, passed in). */
export interface ActivityThresholds {
  /** Received + sent interface bytes in a minute. */
  networkMinBytesPerMinute: number;
  /** CPU millicores: 1000 = one core busy for the whole minute. */
  cpuMinMillicores: number;
}

export interface SandboxActivityRecord {
  /** Floor of every clock: when the recorder (the server) started. A
   * sandbox created or resumed later floors at its `lifecycle` signal. */
  since: number;
  /** Last time each signal was seen (epoch ms). */
  last: Partial<Record<ActivitySignal, number>>;
  agent?: {
    /** Did the last poll get a report (false: no `/activity` endpoint, or
     * the agent was unreachable). */
    reporting: boolean;
    polledAt: number;
    /** The last report, its bucket times rebased onto the server clock. */
    report?: AgentActivityReport;
  };
}

export class ActivityRecorder {
  private readonly records = new Map<string, SandboxActivityRecord>();
  /** When recording started: the floor of every sandbox's clock. */
  private readonly startedAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  /** The sandbox's record without creating one: an empty record floored at
   * the recorder's start when nothing was seen yet. */
  read(id: string): SandboxActivityRecord {
    return this.records.get(id) ?? { since: this.startedAt, last: {} };
  }

  private record(id: string): SandboxActivityRecord {
    let record = this.records.get(id);
    if (!record) {
      record = { since: this.startedAt, last: {} };
      this.records.set(id, record);
    }
    return record;
  }

  /** Record a signal seen now (or at `at`). Cheap: called per SSH chunk and
   * per relayed frame. */
  touch(id: string, signal: ActivitySignal, at = this.now()): void {
    const record = this.record(id);
    const prev = record.last[signal];
    if (prev === undefined || at > prev) record.last[signal] = at;
  }

  /**
   * Fold an agent report in. Bucket times are rebased from the agent's clock
   * to the server's (`nowMs` vs our `now`), so guest clock skew doesn't
   * matter. A minute that reaches a threshold marks the signal at the end of
   * that minute (clipped to now). Idempotent: re-ingesting a report only
   * re-asserts the same maxima.
   */
  ingest(
    id: string,
    report: AgentActivityReport,
    thresholds: ActivityThresholds,
  ): void {
    const now = this.now();
    const skew = now - report.nowMs;
    const bucketMs = report.bucketSeconds * 1000;
    const rebased: AgentActivityReport = {
      ...report,
      nowMs: now,
      bootedAtMs: report.bootedAtMs + skew,
      buckets: report.buckets.map((b) => ({ ...b, startMs: b.startMs + skew })),
    };
    const cpuMinMs = thresholds.cpuMinMillicores * 60;
    for (const bucket of rebased.buckets) {
      const at = Math.min(bucket.startMs + bucketMs, now);
      if (
        bucket.receivedBytes + bucket.sentBytes >=
        thresholds.networkMinBytesPerMinute
      ) {
        this.touch(id, "network", at);
      }
      if (bucket.fileWrites > 0) this.touch(id, "files", at);
      if (bucket.cpuMs >= cpuMinMs) this.touch(id, "cpu", at);
    }
    this.record(id).agent = { reporting: true, polledAt: now, report: rebased };
  }

  /** The agent has no `/activity` (an older image) or didn't answer. Keeps
   * the previous report's data out of the view. */
  markUnreported(id: string): void {
    this.record(id).agent = { reporting: false, polledAt: this.now() };
  }

  /** Drop a destroyed sandbox's state. */
  forget(id: string): void {
    this.records.delete(id);
  }
}
