import { beforeEach, describe, expect, test } from "bun:test";
import { JobService } from "./jobs.service.ts";
import type { JobRecord } from "./store.ts";
import { useTestDatabase } from "./test-database.ts";

beforeEach(() => useTestDatabase());

const sandbox = {
  id: "sbx_1",
  urls: [{ name: "ssh", url: "ssh://x" }],
  generated: { agentPassword: "s3cret", podIp: "10.0.0.7" },
};

async function settled(jobs: JobService, id: string): Promise<JobRecord> {
  for (let i = 0; i < 50; i++) {
    const job = jobs.get(id);
    if (job.status === "succeeded" || job.status === "failed") return job;
    await Bun.sleep(5);
  }
  throw new Error("job did not settle");
}

describe("JobService results never carry `generated`", () => {
  test("track returns the full value but stores/emits it stripped", async () => {
    const jobs = new JobService();
    const emitted: JobRecord[] = [];
    jobs.subscribe(new AbortController().signal, (j) => emitted.push(j));

    const result = await jobs.track({ kind: "sandbox-resume" }, async () => ({
      ...sandbox,
    }));

    expect(result.generated).toEqual(sandbox.generated);
    const [stored] = jobs.list();
    expect(stored?.result).toEqual({ id: "sbx_1", urls: sandbox.urls });
    expect(JSON.stringify(emitted)).not.toContain("s3cret");
    expect(JSON.stringify(jobs.list())).not.toContain("s3cret");
  });

  test("an unpooled dispatch keeps metadata and a usable result", async () => {
    const jobs = new JobService();
    const emitted: JobRecord[] = [];
    jobs.subscribe(new AbortController().signal, (j) => emitted.push(j));

    const job = jobs.dispatch(
      {
        kind: "sandbox-create",
        unpooled: true,
        metadata: { sandboxId: "sbx_1" },
      },
      async () => ({ ...sandbox }),
    );
    const done = await settled(jobs, job.id);

    expect(done.metadata?.sandboxId).toBe("sbx_1");
    expect(done.result).toEqual({ id: "sbx_1", urls: sandbox.urls });
    expect(JSON.stringify(emitted)).not.toContain("podIp");
  });

  test("non-object results pass through untouched", async () => {
    const jobs = new JobService();
    const job = jobs.dispatch({ kind: "prebuild" }, async () => "ref-1");
    expect((await settled(jobs, job.id)).result).toBe("ref-1");
  });
});

describe("dispatchAndWait", () => {
  test("is a pooled job in the feed whose result comes back inline", async () => {
    const jobs = new JobService({ concurrency: 1 });
    const release: Array<() => void> = [];
    const gate = () =>
      new Promise<void>((resolve) => {
        release.push(resolve);
      });
    const first = jobs.dispatchAndWait({ kind: "prebuild" }, async () => {
      await gate();
      return "one";
    });
    const second = jobs.dispatchAndWait(
      { kind: "prebuild" },
      async () => "two",
    );

    // Bounded by the pool: the second waits for the first's slot.
    expect(
      jobs
        .list()
        .map((j) => j.status)
        .sort(),
    ).toEqual(["queued", "running"]);
    release[0]?.();
    expect(await first).toBe("one");
    expect(await second).toBe("two");
    expect(jobs.list().every((j) => j.status === "succeeded")).toBe(true);
  });

  test("a failure rejects the caller and fails the job", async () => {
    const jobs = new JobService();
    await expect(
      jobs.dispatchAndWait({ kind: "prebuild" }, async () => {
        throw new Error("bake failed");
      }),
    ).rejects.toThrow("bake failed");
    const [job] = jobs.list();
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("bake failed");
  });
});
