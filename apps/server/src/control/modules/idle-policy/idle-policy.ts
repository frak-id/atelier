/**
 * Idle auto-pause POLICY (docs/proposals/sandbox-idle-autopause.md §4-5).
 * The rules are the operator's `sandbox.idle.*` server config keys; nothing
 * here is org- or user-settable except a bounded per-sandbox keep-awake.
 *
 * `evaluateIdle` is pure: the reaper and the activity view feed it the
 * runtime's activity clocks plus the live blockers and get back the state,
 * the deadline and whether to pause now.
 */
import type {
  ActivitySignal,
  IdleBlocker,
  IdleMode,
  IdleState,
  SandboxStatus,
} from "@atelier/spec";
import { ValidationError } from "../../../shared/errors.ts";
import type { ServerConfigService } from "../server-config/index.ts";

export interface IdleRule {
  mode: IdleMode;
  minutes: number;
  network: boolean;
  networkMinBytesPerMinute: number;
  files: boolean;
  cpu: boolean;
  cpuMinMillicores: number;
  maxKeepAwakeHours: number;
}

/** Signals that always count: a person or a server-driven agent acting. */
const ALWAYS_COUNTED: ActivitySignal[] = [
  "ssh",
  "console",
  "api",
  "lifecycle",
  "agent",
];

/** Signals only the in-pod agent can report. */
const AGENT_SIGNALS = new Set<ActivitySignal>(["network", "files", "cpu"]);

/** The signals `rule` counts as activity. */
export function countedSignals(rule: IdleRule): ActivitySignal[] {
  const out = [...ALWAYS_COUNTED];
  if (rule.network) out.push("network");
  if (rule.files) out.push("files");
  if (rule.cpu) out.push("cpu");
  return out;
}

export interface IdleInput {
  status: SandboxStatus;
  now: number;
  /** Floor of the clock (when the server started recording). */
  since: number;
  /** Last time each signal was seen. */
  last: Partial<Record<ActivitySignal, number>>;
  /** Whether the agent's last poll returned a report (undefined: not polled
   * yet). */
  agentReporting: boolean | undefined;
  /** The keep-awake annotation, raw. */
  keepAwakeUntil?: string;
  /** Server-driven ACP work in flight. */
  work: { turns: number; permissions: number };
  jobActive: boolean;
  opPending: boolean;
}

export interface IdleEvaluation {
  state: IdleState;
  counted: ActivitySignal[];
  lastActiveAt: number;
  /** Undefined when the rules are off or the sandbox isn't running. */
  pausesAt?: number;
  blockers: IdleBlocker[];
  /** Pause it now (enforce mode, due, nothing blocking). */
  shouldPause: boolean;
}

/** Whether a keep-awake value exempts the sandbox at `now`. */
function keepAwakeActive(value: string | undefined, now: number): boolean {
  if (!value) return false;
  const until = Date.parse(value);
  return Number.isFinite(until) && until > now;
}

export function evaluateIdle(rule: IdleRule, input: IdleInput): IdleEvaluation {
  const counted = countedSignals(rule);
  let lastActiveAt = input.since;
  for (const signal of counted) {
    const at = input.last[signal];
    if (at !== undefined && at > lastActiveAt) lastActiveAt = at;
  }
  const base = { counted, lastActiveAt, blockers: [], shouldPause: false };
  if (rule.mode === "off") return { ...base, state: "off" };
  if (input.status !== "running") return { ...base, state: "not-running" };

  const blockers: IdleBlocker[] = [];
  if (keepAwakeActive(input.keepAwakeUntil, input.now)) {
    blockers.push("keep-awake");
  }
  if (input.work.turns > 0) blockers.push("agent-turn");
  if (input.work.permissions > 0) blockers.push("permission-pending");
  if (input.jobActive) blockers.push("job");
  if (input.opPending) blockers.push("lifecycle-op");
  if (
    input.agentReporting !== true &&
    counted.some((s) => AGENT_SIGNALS.has(s))
  ) {
    blockers.push("agent-unreported");
  }

  const pausesAt = lastActiveAt + rule.minutes * 60_000;
  if (blockers.length > 0) {
    return { ...base, state: "blocked", pausesAt, blockers };
  }
  if (input.now < pausesAt) return { ...base, state: "active", pausesAt };
  return {
    ...base,
    state: "due",
    pausesAt,
    shouldPause: rule.mode === "enforce",
  };
}

export class IdlePolicyService {
  constructor(private readonly config: ServerConfigService) {}

  /** The operator's rule, read live (console edits apply on the next tick). */
  rule(): IdleRule {
    const get = this.config.get.bind(this.config);
    return {
      mode: get("sandbox.idle.mode"),
      minutes: get("sandbox.idle.minutes"),
      network: get("sandbox.idle.network"),
      networkMinBytesPerMinute: get("sandbox.idle.networkMinBytesPerMinute"),
      files: get("sandbox.idle.files"),
      cpu: get("sandbox.idle.cpu"),
      cpuMinMillicores: get("sandbox.idle.cpuMinMillicores"),
      maxKeepAwakeHours: get("sandbox.idle.maxKeepAwakeHours"),
    };
  }

  /**
   * Validate a requested keep-awake against the operator's bounds and
   * normalize it: `null` (clear) → undefined, or an ISO time in the future no further than `maxKeepAwakeHours` away.
   */
  parseKeepAwake(value: string | null, now = Date.now()): string | undefined {
    if (value === null || value.trim() === "") return undefined;
    const rule = this.rule();
    const until = Date.parse(value);
    if (!Number.isFinite(until)) {
      throw new ValidationError("keepAwakeUntil must be an ISO time");
    }
    if (until <= now) {
      throw new ValidationError("keepAwakeUntil must be in the future");
    }
    // A minute of slack for clock skew between the client and the server.
    const max = now + rule.maxKeepAwakeHours * 3_600_000 + 60_000;
    if (until > max) {
      throw new ValidationError(
        `A sandbox can be kept awake at most ${rule.maxKeepAwakeHours} h ` +
          "ahead on this server.",
      );
    }
    return new Date(until).toISOString();
  }
}
