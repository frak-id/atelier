import { describe, expect, test } from "bun:test";
import { JobService } from "./jobs.service.ts";
import type { JobRecord } from "./store.ts";

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
