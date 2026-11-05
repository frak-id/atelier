/**
 * Auto-resume plumbing: `ensureResuming` starts one resume job per paused
 * sandbox (shared by concurrent requests, cooled down after a failure) and
 * `waitForRunning` is the SSH proxy's bounded wait.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Local mode, set before anything loads the server config.
process.env.ATELIER_SERVER_MODE = "local";

const { JobService } = await import("../runtime/jobs.service.ts");
const { useTestDatabase } = await import("../runtime/test-database.ts");
// `wake.ts` reaches for the resume credentials through the v1 routes; the
// container below answers just what that needs.
const { ensureResuming, waitForRunning } = await import("./wake.ts");

beforeEach(() => useTestDatabase());

function makeContainer(initial: string) {
  const state = { status: initial, resumes: 0, failNext: false };
  const jobs = new JobService();
  const container = {
    jobs,
    runtime: {
      getStatus: () => state.status,
      get: async () => ({ metadata: {} }),
      resume: mock(async () => {
        state.resumes++;
        await Bun.sleep(5);
        if (state.failNext) throw new Error("resume failed");
        state.status = "running";
      }),
    },
    control: { userService: { getById: () => undefined } },
  };
  return { container, state, jobs };
}

describe("ensureResuming", () => {
  test("a running sandbox needs nothing", () => {
    const { container, state } = makeContainer("running");
    expect(ensureResuming(container as never, "sb1")).toBe(false);
    expect(state.resumes).toBe(0);
  });

  test("only `paused` wakes: an errored sandbox is left alone", () => {
    const { container, state } = makeContainer("error");
    expect(ensureResuming(container as never, "sb1")).toBe(false);
    expect(state.resumes).toBe(0);
  });

  test("concurrent requests share one resume job", async () => {
    const { container, state, jobs } = makeContainer("paused");
    expect(ensureResuming(container as never, "sb2")).toBe(true);
    expect(ensureResuming(container as never, "sb2")).toBe(true);
    expect(ensureResuming(container as never, "sb2")).toBe(true);
    await Bun.sleep(30);
    expect(state.resumes).toBe(1);
    const resumes = jobs.list().filter((j) => j.kind === "sandbox-resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.target).toBe("sb2");
    expect(resumes[0]?.status).toBe("succeeded");
  });

  test("a failed resume is not retried on every request", async () => {
    const { container, state } = makeContainer("paused");
    state.failNext = true;
    const t0 = 1_000_000;
    expect(ensureResuming(container as never, "sb3", t0)).toBe(true);
    await Bun.sleep(30); // the resume failed; the sandbox is still paused
    expect(ensureResuming(container as never, "sb3", t0 + 1_000)).toBe(true);
    await Bun.sleep(30);
    expect(state.resumes).toBe(1);
    // Past the cooldown it tries again.
    expect(ensureResuming(container as never, "sb3", t0 + 60_000)).toBe(true);
    await Bun.sleep(30);
    expect(state.resumes).toBe(2);
  });
});

describe("waitForRunning", () => {
  /** A fake clock: sleeping advances it. */
  function clock() {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  }

  test("resolves once the sandbox runs", async () => {
    const seq = ["paused", "paused", "running"];
    const ok = await waitForRunning(() => seq.shift(), {
      waking: () => true,
      timeoutMs: 180_000,
      ...clock(),
    });
    expect(ok).toBe(true);
  });

  test("gives up at the timeout", async () => {
    const ok = await waitForRunning(() => "paused", {
      waking: () => true,
      timeoutMs: 180_000,
      pollMs: 1000,
      ...clock(),
    });
    expect(ok).toBe(false);
  });

  test("gives up at once when the resume failed or the sandbox is not coming up", async () => {
    const c = clock();
    expect(
      await waitForRunning(() => "paused", {
        waking: () => false,
        timeoutMs: 180_000,
        ...c,
      }),
    ).toBe(false);
    expect(c.now()).toBe(0);
    for (const status of ["error", "stopped", undefined]) {
      expect(
        await waitForRunning(() => status, {
          waking: () => true,
          timeoutMs: 180_000,
          ...clock(),
        }),
      ).toBe(false);
    }
  });

  test("a sandbox still being created is waited for", async () => {
    const seq = ["creating", "running"];
    expect(
      await waitForRunning(() => seq.shift(), {
        waking: () => false,
        timeoutMs: 10_000,
        ...clock(),
      }),
    ).toBe(true);
  });
});
