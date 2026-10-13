import { describe, expect, test } from "bun:test";
import {
  ActivityRecorder,
  type AgentActivityReport,
  activitySettingsToPush,
} from "./activity.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-14T12:00:00Z");
const THRESHOLDS = {
  networkMinBytesPerMinute: 1000,
  cpuMinMsPerMinute: 15_000,
};

function report(
  agentNow: number,
  buckets: Partial<AgentActivityReport["buckets"][number]>[],
): AgentActivityReport {
  return {
    nowMs: agentNow,
    bootedAtMs: agentNow - 60 * MIN,
    bucketSeconds: 60,
    network: "sock_diag",
    files: "fanotify",
    cpu: "cgroup2",
    fileSettings: { roots: [], exclude: [] },
    buckets: buckets.map((b) => ({
      startMs: 0,
      inboundBytes: 0,
      outboundBytes: 0,
      fileWrites: 0,
      cpuMs: 0,
      ...b,
    })),
    processes: [],
  };
}

describe("ActivityRecorder", () => {
  test("touch keeps the latest time per signal; the floor is the start", () => {
    let now = T0;
    const recorder = new ActivityRecorder(() => now);
    now = T0 + 5 * MIN;
    recorder.touch("s", "ssh");
    recorder.touch("s", "ssh", T0 + MIN);
    expect(recorder.get("s")).toEqual({
      since: T0,
      last: { ssh: T0 + 5 * MIN },
    });
  });

  test("a minute counts when it reaches its threshold, at its end", () => {
    const now = T0;
    const recorder = new ActivityRecorder(() => now);
    recorder.ingest(
      "s",
      report(T0, [
        // Heartbeats only: below the byte threshold.
        { startMs: T0 - 30 * MIN, inboundBytes: 900, outboundBytes: 900 },
        { startMs: T0 - 20 * MIN, inboundBytes: 5000 },
        { startMs: T0 - 15 * MIN, outboundBytes: 1000, fileWrites: 2 },
        { startMs: T0 - 10 * MIN, cpuMs: 14_999 },
        { startMs: T0 - 5 * MIN, cpuMs: 20_000 },
      ]),
      THRESHOLDS,
    );
    expect(recorder.get("s")?.last).toEqual({
      networkInbound: T0 - 19 * MIN,
      networkOutbound: T0 - 14 * MIN,
      files: T0 - 14 * MIN,
      cpu: T0 - 4 * MIN,
    });
    expect(recorder.get("s")?.agent?.reporting).toBe(true);
  });

  test("interface counters: received + sent count for both directions", () => {
    const now = T0;
    const recorder = new ActivityRecorder(() => now);
    recorder.ingest(
      "s",
      {
        ...report(T0, [
          // Neither direction alone reaches 1000; together they do.
          { startMs: T0 - 20 * MIN, inboundBytes: 600, outboundBytes: 600 },
          { startMs: T0 - 10 * MIN, inboundBytes: 400, outboundBytes: 500 },
        ]),
        network: "netdev",
      },
      THRESHOLDS,
    );
    expect(recorder.get("s")?.last).toEqual({
      networkInbound: T0 - 19 * MIN,
      networkOutbound: T0 - 19 * MIN,
    });
  });

  test("bucket times are rebased from the agent's clock to ours", () => {
    const recorder = new ActivityRecorder(() => T0);
    // The guest clock runs an hour ahead.
    const skewed = T0 + 60 * MIN;
    recorder.ingest(
      "s",
      report(skewed, [{ startMs: skewed - 3 * MIN, fileWrites: 1 }]),
      THRESHOLDS,
    );
    expect(recorder.get("s")?.last.files).toBe(T0 - 2 * MIN);
    expect(recorder.get("s")?.agent?.report?.buckets[0]?.startMs).toBe(
      T0 - 3 * MIN,
    );
  });

  test("the current minute is clipped to now", () => {
    const recorder = new ActivityRecorder(() => T0);
    recorder.ingest(
      "s",
      report(T0, [{ startMs: T0 - 20_000, fileWrites: 1 }]),
      THRESHOLDS,
    );
    expect(recorder.get("s")?.last.files).toBe(T0);
  });

  test("an unreported poll drops the previous report; forget drops all", () => {
    const recorder = new ActivityRecorder(() => T0);
    recorder.ingest("s", report(T0, []), THRESHOLDS);
    recorder.touch("s", "api");
    recorder.markUnreported("s");
    expect(recorder.get("s")?.agent).toEqual({
      reporting: false,
      polledAt: T0,
    });
    expect(recorder.get("s")?.last.api).toBe(T0);
    recorder.forget("s");
    expect(recorder.get("s")).toBeUndefined();
  });
});

describe("activitySettingsToPush", () => {
  const wanted = {
    roots: ["/home/dev"],
    exclude: ["node_modules", "/home/dev/.*"],
  };

  test("nothing to push when the agent has them", () => {
    expect(activitySettingsToPush(wanted, wanted)).toBeUndefined();
  });

  test("a change is pushed whole", () => {
    expect(activitySettingsToPush({ ...wanted, exclude: [] }, wanted)).toEqual(
      wanted,
    );
  });
});
