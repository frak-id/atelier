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
import { type ActivitySignal, INTERFACE_NETWORK_SENSOR } from "@atelier/spec";

/** One minute bucket as the agent reports it (`apps/agent/src/activity`). */
interface AgentActivityBucket {
  startMs: number;
  inboundBytes: number;
  outboundBytes: number;
  fileWrites: number;
  cpuMs: number;
}

interface AgentProcessTraffic {
  name: string;
  supervised: boolean;
  inboundBytes: number;
  outboundBytes: number;
}

/** The agent's `GET /activity` body. */
export interface AgentActivityReport {
  nowMs: number;
  bootedAtMs: number;
  bucketSeconds: number;
  network: string;
  files: string;
  cpu: string;
  fileSettings: AgentActivitySettings;
  buckets: AgentActivityBucket[];
  processes: AgentProcessTraffic[];
}

/** The agent-side file filter (`PUT /activity/settings`). */
export interface AgentActivitySettings {
  roots: string[];
  exclude: string[];
}

/** The file filter to push to an agent reporting `reported`, or undefined
 * when it already has it. */
export function activitySettingsToPush(
  reported: AgentActivitySettings,
  wanted: AgentActivitySettings,
): AgentActivitySettings | undefined {
  const same = (x: string[], y: string[]) =>
    x.length === y.length && x.every((v, i) => v === y[i]);
  return same(wanted.roots, reported.roots) &&
    same(wanted.exclude, reported.exclude)
    ? undefined
    : wanted;
}

/** What a minute must reach to count as activity (policy, passed in). */
export interface ActivityThresholds {
  /** Per direction: a minute counts for `networkInbound` when its inbound
   * bytes reach this, likewise outbound. From an agent measuring interface
   * counters ({@link INTERFACE_NETWORK_SENSOR}), received + sent reach it
   * and count for both directions. */
  networkMinBytesPerMinute: number;
  /** CPU milliseconds in a minute (1000 ms = one core for a second). */
  cpuMinMsPerMinute: number;
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
  readonly startedAt: number;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
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
    const undirected = report.network === INTERFACE_NETWORK_SENSOR;
    const min = thresholds.networkMinBytesPerMinute;
    for (const bucket of rebased.buckets) {
      const at = Math.min(bucket.startMs + bucketMs, now);
      const total = bucket.inboundBytes + bucket.outboundBytes;
      if (undirected ? total >= min : bucket.inboundBytes >= min) {
        this.touch(id, "networkInbound", at);
      }
      if (undirected ? total >= min : bucket.outboundBytes >= min) {
        this.touch(id, "networkOutbound", at);
      }
      if (bucket.fileWrites > 0) this.touch(id, "files", at);
      if (bucket.cpuMs >= thresholds.cpuMinMsPerMinute) {
        this.touch(id, "cpu", at);
      }
    }
    this.record(id).agent = { reporting: true, polledAt: now, report: rebased };
  }

  /** The agent has no `/activity` (an older image) or didn't answer. Keeps
   * the previous report's data out of the view. */
  markUnreported(id: string): void {
    this.record(id).agent = { reporting: false, polledAt: this.now() };
  }

  get(id: string): SandboxActivityRecord | undefined {
    return this.records.get(id);
  }

  /** Drop a destroyed sandbox's state. */
  forget(id: string): void {
    this.records.delete(id);
  }
}
