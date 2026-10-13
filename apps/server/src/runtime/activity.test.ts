import { describe, expect, test } from "bun:test";
import { ActivityRecorder, type AgentActivityReport } from "./activity.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-14T12:00:00Z");
const THRESHOLDS = {
  networkMinBytesPerMinute: 1000,
  cpuMinMillicores: 250,
};

function report(
  agentNow: number,
  buckets: Partial<AgentActivityReport["buckets"][number]>[],
): AgentActivityReport {
  return {
    nowMs: agentNow,
    bootedAtMs: agentNow - 60 * MIN,
    bucketSeconds: 60,
    network: "netdev",
    files: "fanotify",
    cpu: "cgroup2",
    buckets: buckets.map((b) => ({
      startMs: 0,
      receivedBytes: 0,
      sentBytes: 0,
      fileWrites: 0,
      cpuMs: 0,
      ...b,
    })),
  };
}

describe("ActivityRecorder", () => {
  test("touch keeps the latest time per signal; the floor is the start", () => {
    let now = T0;
    const recorder = new ActivityRecorder(() => now);
    now = T0 + 5 * MIN;
    recorder.touch("s", "ssh");
    recorder.touch("s", "ssh", T0 + MIN);
    expect(recorder.read("s")).toEqual({
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
        { startMs: T0 - 30 * MIN, receivedBytes: 400, sentBytes: 500 },
        // Received + sent together reach it.
        { startMs: T0 - 20 * MIN, receivedBytes: 600, sentBytes: 400 },
        { startMs: T0 - 15 * MIN, fileWrites: 2 },
        { startMs: T0 - 10 * MIN, cpuMs: 14_999 },
        { startMs: T0 - 5 * MIN, cpuMs: 15_000 },
      ]),
      THRESHOLDS,
    );
    expect(recorder.read("s").last).toEqual({
      network: T0 - 19 * MIN,
      files: T0 - 14 * MIN,
      cpu: T0 - 4 * MIN,
    });
    expect(recorder.read("s").agent?.reporting).toBe(true);
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
    expect(recorder.read("s").last.files).toBe(T0 - 2 * MIN);
    expect(recorder.read("s").agent?.report?.buckets[0]?.startMs).toBe(
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
    expect(recorder.read("s").last.files).toBe(T0);
  });

  test("an unreported poll drops the previous report; forget drops all", () => {
    const recorder = new ActivityRecorder(() => T0);
    recorder.ingest("s", report(T0, []), THRESHOLDS);
    recorder.touch("s", "api");
    recorder.markUnreported("s");
    expect(recorder.read("s").agent).toEqual({
      reporting: false,
      polledAt: T0,
    });
    expect(recorder.read("s").last.api).toBe(T0);
    recorder.forget("s");
    expect(recorder.read("s")).toEqual({ since: T0, last: {} });
  });
});
