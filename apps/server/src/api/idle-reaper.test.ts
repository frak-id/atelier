import { describe, expect, test } from "bun:test";
import {
  SANDBOX_IDLE_PAUSED_ANNOTATION,
  SANDBOX_KEEP_AWAKE_ANNOTATION,
  type SandboxStatus,
} from "@atelier/spec";
import type { ServerConfigService } from "../control/index.ts";
import { IdlePolicyService } from "../control/modules/idle-policy/index.ts";
import {
  ActivityRecorder,
  type AgentActivityReport,
} from "../runtime/activity.ts";
import { NotFoundError, ValidationError } from "../shared/errors.ts";
import { IdleReaper } from "./idle-reaper.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-14T08:00:00Z");

interface FakeSandbox {
  status: SandboxStatus;
  annotations: Record<string, string>;
}

function harness(config: Record<string, unknown> = {}) {
  const clock = { now: T0 };
  const recorder = new ActivityRecorder(() => clock.now);
  const sandboxes = new Map<string, FakeSandbox>();
  const calls: string[] = [];
  const state = {
    work: { turns: 0, permissions: 0 },
    jobActive: false,
    /** The agent's report, or null for an agent without `/activity`. */
    report: (_now: number): AgentActivityReport | null => ({
      nowMs: clock.now,
      bootedAtMs: T0,
      bucketSeconds: 60,
      network: "sock_diag",
      files: "fanotify",
      cpu: "cgroup2",
      fileSettings: { roots: [], exclude: [] },
      buckets: [],
      processes: [],
    }),
    /** Runs on each poll, after the report is folded in. */
    onPoll: (_id: string) => {},
  };
  const values: Record<string, unknown> = {
    "sandbox.idle.mode": "enforce",
    "sandbox.idle.minutes": 120,
    "sandbox.idle.network": "both",
    "sandbox.idle.networkMinBytesPerMinute": 1000,
    "sandbox.idle.files": true,
    "sandbox.idle.fileRoots": "/home/dev/workspace",
    "sandbox.idle.fileExcludes": "node_modules",
    "sandbox.idle.cpu": false,
    "sandbox.idle.cpuMinMillicores": 250,
    "sandbox.idle.maxKeepAwakeHours": 24,
    "sandbox.idle.allowKeepAwakeForever": false,
    ...config,
  };
  const policy = new IdlePolicyService({
    get: (key: string) => values[key],
  } as unknown as ServerConfigService);

  const runtime = {
    list: () =>
      [...sandboxes].map(([id, s]) => ({
        id,
        status: s.status,
        createdAt: "",
        metadata: {},
        annotations: { ...s.annotations },
      })),
    getStatus: (id: string) => sandboxes.get(id)?.status,
    getLabels: (id: string) => {
      const s = sandboxes.get(id);
      return s && { metadata: {}, annotations: { ...s.annotations } };
    },
    activityRecord: (id: string) =>
      recorder.get(id) ?? { since: recorder.startedAt, last: {} },
    hasPendingOp: () => false,
    pollActivity: async (
      id: string,
      thresholds: Parameters<ActivityRecorder["ingest"]>[2],
      settings?: { roots: string[]; exclude: string[] },
    ) => {
      calls.push(`poll:${id}:${settings?.roots.join(",")}`);
      const report = state.report(clock.now);
      if (report) recorder.ingest(id, report, thresholds);
      else recorder.markUnreported(id);
      state.onPoll(id);
      return recorder.get(id);
    },
    pause: async (id: string) => {
      calls.push(`pause:${id}`);
      const s = sandboxes.get(id);
      if (s) s.status = "paused";
      return { ref: "snap", hash: "h" };
    },
    setAnnotation: (id: string, key: string, value: string | undefined) => {
      const s = sandboxes.get(id);
      if (!s) return;
      if (value === undefined) delete s.annotations[key];
      else s.annotations[key] = value;
    },
  };
  const jobs = {
    track: async <T>(
      opts: { kind: string; target?: string },
      fn: (signal: AbortSignal, log: (s: string) => void) => Promise<T>,
    ) => {
      calls.push(`job:${opts.kind}:${opts.target}`);
      return fn(new AbortController().signal, () => {});
    },
    hasActiveFor: () => state.jobActive,
  };
  const dispatch = { workFor: () => state.work };
  const reaper = new IdleReaper({
    runtime: runtime as never,
    jobs: jobs as never,
    dispatch,
    policy,
    now: () => clock.now,
  });
  const add = (id: string, status: SandboxStatus = "running") =>
    sandboxes.set(id, { status, annotations: {} });
  const sandbox = (id: string): FakeSandbox => {
    const s = sandboxes.get(id);
    if (!s) throw new Error(`no sandbox ${id}`);
    return s;
  };
  return {
    reaper,
    recorder,
    sandboxes,
    sandbox,
    calls,
    clock,
    state,
    values,
    add,
  };
}

describe("IdleReaper.tick", () => {
  test("enforce pauses a sandbox idle past the window and marks why", async () => {
    const h = harness();
    h.add("idle");
    h.add("busy");
    h.clock.now = T0 + 121 * MIN;
    h.recorder.touch("busy", "console", T0 + 100 * MIN);
    await h.reaper.tick();
    expect(h.calls).toContain("job:sandbox-pause:idle");
    expect(h.calls).not.toContain("pause:busy");
    expect(h.sandboxes.get("idle")?.status).toBe("paused");
    expect(
      h.sandboxes.get("idle")?.annotations[SANDBOX_IDLE_PAUSED_ANNOTATION],
    ).toBe(new Date(T0 + 121 * MIN).toISOString());
    // The operator's file filter rides each poll.
    expect(h.calls).toContain("poll:busy:/home/dev/workspace");
  });

  test("observe polls but never pauses; off doesn't even poll", async () => {
    const h = harness({ "sandbox.idle.mode": "observe" });
    h.add("idle");
    h.clock.now = T0 + 300 * MIN;
    await h.reaper.tick();
    expect(h.calls.some((c) => c.startsWith("poll:"))).toBe(true);
    expect(h.calls.some((c) => c.startsWith("pause:"))).toBe(false);

    h.values["sandbox.idle.mode"] = "off";
    h.calls.length = 0;
    await h.reaper.tick();
    expect(h.calls).toEqual([]);
  });

  test("agent-measured traffic above the threshold keeps it awake", async () => {
    const h = harness();
    h.add("s");
    h.clock.now = T0 + 300 * MIN;
    h.state.report = (now) => ({
      nowMs: now,
      bootedAtMs: T0,
      bucketSeconds: 60,
      network: "sock_diag",
      files: "fanotify",
      cpu: "cgroup2",
      fileSettings: { roots: [], exclude: [] },
      buckets: [
        // Heartbeats: under the threshold, don't count.
        {
          startMs: now - 2 * MIN,
          inboundBytes: 400,
          outboundBytes: 0,
          fileWrites: 0,
          cpuMs: 0,
        },
        // An LLM stream half an hour ago.
        {
          startMs: now - 30 * MIN,
          inboundBytes: 0,
          outboundBytes: 50_000,
          fileWrites: 0,
          cpuMs: 0,
        },
      ],
      processes: [],
    });
    await h.reaper.tick();
    expect(h.calls.some((c) => c.startsWith("pause:"))).toBe(false);
    expect(h.reaper.evaluate("s")?.lastActiveAt).toBe(
      T0 + 300 * MIN - 29 * MIN,
    );
  });

  test("someone coming back between the two polls cancels the pause", async () => {
    const h = harness();
    h.add("s");
    h.clock.now = T0 + 200 * MIN;
    let polls = 0;
    h.state.onPoll = (id) => {
      if (++polls === 2) h.recorder.touch(id, "ssh");
    };
    await h.reaper.tick();
    expect(polls).toBe(2);
    expect(h.sandboxes.get("s")?.status).toBe("running");
  });

  test("a pending permission, a turn, a job or keep-awake holds it", async () => {
    const holds: ((h: ReturnType<typeof harness>) => void)[] = [
      (h) => {
        h.state.work = { turns: 0, permissions: 1 };
      },
      (h) => {
        h.state.work = { turns: 1, permissions: 0 };
      },
      (h) => {
        h.state.jobActive = true;
      },
      (h) => {
        h.sandbox("s").annotations[SANDBOX_KEEP_AWAKE_ANNOTATION] = new Date(
          T0 + 400 * MIN,
        ).toISOString();
      },
    ];
    for (const hold of holds) {
      const h = harness();
      h.add("s");
      h.clock.now = T0 + 300 * MIN;
      hold(h);
      await h.reaper.tick();
      expect(h.sandboxes.get("s")?.status).toBe("running");
      expect(h.reaper.evaluate("s")?.state).toBe("blocked");
    }
  });

  test("an agent without /activity is never paused while its signals count", async () => {
    const h = harness();
    h.add("s");
    h.clock.now = T0 + 300 * MIN;
    h.state.report = () => null;
    await h.reaper.tick();
    expect(h.sandboxes.get("s")?.status).toBe("running");
    expect(h.reaper.evaluate("s")?.blockers).toEqual(["agent-unreported"]);

    // With only server-side signals counted, it can be judged.
    h.values["sandbox.idle.network"] = "off";
    h.values["sandbox.idle.files"] = false;
    await h.reaper.tick();
    expect(h.sandboxes.get("s")?.status).toBe("paused");
  });

  test("stale annotations go: an idle mark once running, an expired keep-awake", async () => {
    const h = harness({ "sandbox.idle.mode": "off" });
    h.add("s");
    const s = h.sandbox("s");
    s.annotations[SANDBOX_IDLE_PAUSED_ANNOTATION] = "2026-10-13T00:00:00Z";
    s.annotations[SANDBOX_KEEP_AWAKE_ANNOTATION] = new Date(
      T0 - MIN,
    ).toISOString();
    h.add("p", "paused");
    h.sandbox("p").annotations[SANDBOX_IDLE_PAUSED_ANNOTATION] = "x";
    await h.reaper.tick();
    expect(s.annotations).toEqual({});
    expect(h.sandboxes.get("p")?.annotations).toEqual({
      [SANDBOX_IDLE_PAUSED_ANNOTATION]: "x",
    });
  });
});

describe("IdleReaper surfaces", () => {
  test("decorate adds the idle state to running rows only", async () => {
    const h = harness();
    h.add("r");
    h.add("p", "paused");
    const decorate = () =>
      h.reaper.decorate(
        [...h.sandboxes.keys()].map((id) => ({
          id,
          status: h.sandbox(id).status,
          createdAt: "",
          metadata: {},
        })),
      );
    // Until the agent was polled once, its signals are unknown.
    expect(decorate()[0]?.idle?.state).toBe("blocked");
    await h.reaper.tick();
    const rows = decorate();
    expect(rows[0]?.idle).toEqual({
      mode: "enforce",
      state: "active",
      lastActiveAt: new Date(T0).toISOString(),
      pausesAt: new Date(T0 + 120 * MIN).toISOString(),
    });
    expect(rows[1]?.idle).toBeUndefined();
  });

  test("the view carries the rule, the clocks and traffic by process", async () => {
    const h = harness();
    h.add("s");
    h.clock.now = T0 + 10 * MIN;
    h.state.report = (now) => ({
      nowMs: now,
      bootedAtMs: T0,
      bucketSeconds: 60,
      network: "sock_diag",
      files: "inotify",
      cpu: "cgroup2",
      fileSettings: { roots: [], exclude: [] },
      buckets: [
        {
          startMs: now - MIN,
          inboundBytes: 10,
          outboundBytes: 5000,
          fileWrites: 1,
          cpuMs: 3,
        },
      ],
      processes: [
        { name: "git", supervised: false, inboundBytes: 0, outboundBytes: 10 },
        { name: "acp", supervised: true, inboundBytes: 0, outboundBytes: 4990 },
      ],
    });
    await h.reaper.tick();
    const view = h.reaper.view("s");
    expect(view.state).toBe("active");
    expect(view.counted).toContain("networkOutbound");
    expect(view.signals.files).toBe(new Date(T0 + 10 * MIN).toISOString());
    expect(view.signals.networkInbound).toBeUndefined();
    expect(view.agent).toMatchObject({ reporting: true, files: "inotify" });
    expect(view.minutes).toHaveLength(1);
    expect(view.processes.map((p) => p.name)).toEqual(["acp", "git"]);
    expect(() => h.reaper.view("nope")).toThrow(NotFoundError);
  });

  test("keep-awake is validated, stored and cleared", () => {
    const h = harness({ "sandbox.idle.maxKeepAwakeHours": 8 });
    h.add("s");
    const at = new Date(T0 + 60 * MIN).toISOString();
    expect(h.reaper.setKeepAwake("s", at)).toBe(at);
    expect(h.sandboxes.get("s")?.annotations).toEqual({
      [SANDBOX_KEEP_AWAKE_ANNOTATION]: at,
    });
    expect(h.reaper.view("s").keepAwakeUntil).toBe(at);
    expect(() =>
      h.reaper.setKeepAwake("s", new Date(T0 + 9 * 60 * MIN).toISOString()),
    ).toThrow(ValidationError);
    expect(h.reaper.setKeepAwake("s", null)).toBeUndefined();
    expect(h.sandboxes.get("s")?.annotations).toEqual({});
    expect(() => h.reaper.setKeepAwake("nope", null)).toThrow(NotFoundError);
  });
});
