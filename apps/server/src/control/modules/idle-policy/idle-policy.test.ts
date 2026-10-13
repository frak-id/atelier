import { describe, expect, test } from "bun:test";
import { ValidationError } from "../../../shared/errors.ts";
import type { ServerConfigService } from "../server-config/index.ts";
import {
  countedSignals,
  evaluateIdle,
  type IdleInput,
  IdlePolicyService,
  type IdleRule,
} from "./idle-policy.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-10-14T12:00:00Z");

const RULE: IdleRule = {
  mode: "enforce",
  minutes: 120,
  network: true,
  networkMinBytesPerMinute: 65536,
  files: true,
  cpu: false,
  cpuMinMillicores: 250,
  maxKeepAwakeHours: 24,
};

function input(patch: Partial<IdleInput> = {}): IdleInput {
  return {
    status: "running",
    now: NOW,
    since: NOW - 300 * MIN,
    last: {},
    agentReporting: true,
    work: { turns: 0, permissions: 0 },
    jobActive: false,
    opPending: false,
    ...patch,
  };
}

describe("countedSignals", () => {
  test("person and agent signals always count; the rest per rule", () => {
    expect(countedSignals({ ...RULE, network: false, files: false })).toEqual([
      "ssh",
      "console",
      "api",
      "lifecycle",
      "agent",
    ]);
    expect(countedSignals({ ...RULE, cpu: true })).toEqual([
      "ssh",
      "console",
      "api",
      "lifecycle",
      "agent",
      "network",
      "files",
      "cpu",
    ]);
  });
});

describe("evaluateIdle", () => {
  test("idle past the window is due; enforce pauses it", () => {
    const ev = evaluateIdle(RULE, input({ last: { ssh: NOW - 121 * MIN } }));
    expect(ev.state).toBe("due");
    expect(ev.shouldPause).toBe(true);
    expect(ev.lastActiveAt).toBe(NOW - 121 * MIN);
    expect(ev.pausesAt).toBe(NOW - MIN);
  });

  test("observe reports due but never pauses", () => {
    const ev = evaluateIdle({ ...RULE, mode: "observe" }, input());
    expect(ev.state).toBe("due");
    expect(ev.shouldPause).toBe(false);
  });

  test("recent activity keeps it active, with the deadline", () => {
    const ev = evaluateIdle(
      RULE,
      input({ last: { console: NOW - 10 * MIN, ssh: NOW - 200 * MIN } }),
    );
    expect(ev.state).toBe("active");
    expect(ev.pausesAt).toBe(NOW + 110 * MIN);
    expect(ev.shouldPause).toBe(false);
  });

  test("the clock never starts before `since` (server start / boot)", () => {
    const ev = evaluateIdle(RULE, input({ since: NOW - 5 * MIN }));
    expect(ev.state).toBe("active");
    expect(ev.lastActiveAt).toBe(NOW - 5 * MIN);
  });

  test("signals the rule doesn't count are ignored", () => {
    const last = { network: NOW - MIN, cpu: NOW - MIN };
    expect(
      evaluateIdle({ ...RULE, network: false }, input({ last })).state,
    ).toBe("due");
    expect(evaluateIdle(RULE, input({ last })).state).toBe("active");
  });

  test("each blocker holds the pause, whatever the clock says", () => {
    const cases: [Partial<IdleInput>, string][] = [
      [{ keepAwakeUntil: new Date(NOW + MIN).toISOString() }, "keep-awake"],
      [{ work: { turns: 1, permissions: 0 } }, "agent-turn"],
      [{ work: { turns: 0, permissions: 1 } }, "permission-pending"],
      [{ jobActive: true }, "job"],
      [{ opPending: true }, "lifecycle-op"],
      [{ agentReporting: false }, "agent-unreported"],
      [{ agentReporting: undefined }, "agent-unreported"],
    ];
    for (const [patch, blocker] of cases) {
      const ev = evaluateIdle(RULE, input(patch));
      expect(ev.state).toBe("blocked");
      expect(ev.blockers).toEqual([blocker as never]);
      expect(ev.shouldPause).toBe(false);
    }
  });

  test("an older agent only blocks when agent-side signals count", () => {
    const rule: IdleRule = { ...RULE, network: false, files: false };
    const ev = evaluateIdle(rule, input({ agentReporting: false }));
    expect(ev.state).toBe("due");
  });

  test("an expired or unparsable keep-awake no longer holds", () => {
    const past = new Date(NOW - MIN).toISOString();
    for (const keepAwakeUntil of [past, "forever"]) {
      expect(evaluateIdle(RULE, input({ keepAwakeUntil })).state).toBe("due");
    }
  });

  test("off and not-running have no deadline", () => {
    const off = evaluateIdle({ ...RULE, mode: "off" }, input());
    expect(off.state).toBe("off");
    expect(off.pausesAt).toBeUndefined();
    const paused = evaluateIdle(RULE, input({ status: "paused" }));
    expect(paused.state).toBe("not-running");
    expect(paused.shouldPause).toBe(false);
  });
});

describe("IdlePolicyService.parseKeepAwake", () => {
  function service(patch: Partial<Record<string, unknown>> = {}) {
    const values: Record<string, unknown> = {
      "sandbox.idle.mode": "enforce",
      "sandbox.idle.minutes": 120,
      "sandbox.idle.network": true,
      "sandbox.idle.networkMinBytesPerMinute": 65536,
      "sandbox.idle.files": true,
      "sandbox.idle.cpu": false,
      "sandbox.idle.cpuMinMillicores": 250,
      "sandbox.idle.maxKeepAwakeHours": 8,
      ...patch,
    };
    const config = { get: (key: string) => values[key] };
    return new IdlePolicyService(config as unknown as ServerConfigService);
  }

  test("null or blank clears", () => {
    expect(service().parseKeepAwake(null, NOW)).toBeUndefined();
    expect(service().parseKeepAwake(" ", NOW)).toBeUndefined();
  });

  test("a time within the operator's bound is normalized", () => {
    const at = new Date(NOW + 8 * 60 * MIN).toISOString();
    expect(service().parseKeepAwake(at, NOW)).toBe(at);
  });

  test("past, too far, garbage and forever are refused", () => {
    for (const value of [
      new Date(NOW - MIN).toISOString(),
      new Date(NOW + 9 * 60 * MIN).toISOString(),
      "tomorrow-ish",
      "forever",
    ]) {
      expect(() => service().parseKeepAwake(value, NOW)).toThrow(
        ValidationError,
      );
    }
  });
});
