/**
 * Auto-resume plumbing of `SandboxOps`: `wake` starts one resume job per
 * paused sandbox (shared by concurrent requests, cooled down after a
 * failure), `ensureRunning` is the bounded wait an operation (exec, files,
 * SSH) makes on a paused sandbox, and `waitForRunning` is its poll loop.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

// Local mode, set before anything loads the server config.
process.env.ATELIER_SERVER_MODE = "local";

const { JobService } = await import("../../runtime/jobs.service.ts");
const { useTestDatabase } = await import("../../runtime/test-database.ts");
const { SandboxOps, waitForRunning } = await import("./sandbox-ops.ts");

beforeEach(() => useTestDatabase());

function makeOps(initial: string) {
  const state = { status: initial, resumes: 0, failNext: false, execs: 0 };
  const jobs = new JobService();
  const runtime = {
    getStatus: () => state.status,
    resume: mock(async () => {
      state.resumes++;
      await Bun.sleep(5);
      if (state.failNext) throw new Error("resume failed");
      state.status = "running";
    }),
    exec: mock(async () => {
      state.execs++;
      return { exitCode: 0, stdout: "", stderr: "" };
    }),
  };
  const ops = new SandboxOps({ runtime, jobs } as never);
  return { ops, state, jobs };
}

describe("SandboxOps.wake", () => {
  test("a running sandbox needs nothing", () => {
    const { ops, state } = makeOps("running");
    expect(ops.wake("sb1")).toBe(false);
    expect(state.resumes).toBe(0);
  });

  test("only `paused` wakes: an errored sandbox is left alone", () => {
    const { ops, state } = makeOps("error");
    expect(ops.wake("sb1")).toBe(false);
    expect(state.resumes).toBe(0);
  });

  test("concurrent requests share one resume job", async () => {
    const { ops, state, jobs } = makeOps("paused");
    expect(ops.wake("sb2")).toBe(true);
    expect(ops.wake("sb2")).toBe(true);
    expect(ops.wake("sb2")).toBe(true);
    await Bun.sleep(30);
    expect(state.resumes).toBe(1);
    const resumes = jobs.list().filter((j) => j.kind === "sandbox-resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]?.target).toBe("sb2");
    expect(resumes[0]?.status).toBe("succeeded");
  });

  test("a failed resume is not retried on every request", async () => {
    const { ops, state } = makeOps("paused");
    state.failNext = true;
    const t0 = 1_000_000;
    expect(ops.wake("sb3", t0)).toBe(true);
    await Bun.sleep(30); // the resume failed; the sandbox is still paused
    expect(ops.wake("sb3", t0 + 1_000)).toBe(true);
    await Bun.sleep(30);
    expect(state.resumes).toBe(1);
    // Past the cooldown it tries again.
    expect(ops.wake("sb3", t0 + 60_000)).toBe(true);
    await Bun.sleep(30);
    expect(state.resumes).toBe(2);
  });
});

describe("SandboxOps auto-resume for operations", () => {
  test("exec on a paused sandbox resumes it first", async () => {
    const { ops, state, jobs } = makeOps("paused");
    await ops.exec("sb4", { command: "ls" } as never);
    expect(state.resumes).toBe(1);
    expect(state.execs).toBe(1);
    expect(jobs.list().some((j) => j.kind === "sandbox-resume")).toBe(true);
  });

  test("a running sandbox is not resumed", async () => {
    const { ops, state } = makeOps("running");
    await ops.exec("sb5", { command: "ls" } as never);
    expect(state.resumes).toBe(0);
    expect(state.execs).toBe(1);
  });

  test("an errored sandbox is left to the operation: no resume", async () => {
    const { ops, state } = makeOps("error");
    await ops.exec("sb6", { command: "ls" } as never);
    expect(state.resumes).toBe(0);
  });

  test("a resume that fails is a conflict, and the command never runs", async () => {
    const { ops, state } = makeOps("paused");
    state.failNext = true;
    await expect(ops.exec("sb7", { command: "ls" } as never)).rejects.toThrow(
      "did not resume",
    );
    expect(state.execs).toBe(0);
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
