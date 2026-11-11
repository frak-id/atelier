/**
 * `SandboxOps.startPrebuild`: the GitHub token is resolved inside the job
 * (an App token mint is a network call), so a failure fails the job and not
 * the request that queued it.
 */
import { beforeEach, describe, expect, test } from "bun:test";

// Local mode, set before anything loads the server config.
process.env.ATELIER_SERVER_MODE = "local";

const { JobService } = await import("../../runtime/jobs.service.ts");
const { useTestDatabase } = await import("../../runtime/test-database.ts");
const { SandboxOps } = await import("./sandbox-ops.ts");

beforeEach(() => useTestDatabase());

const spec = {
  source: { image: "registry.test/base:1" },
  repos: [{ url: "https://github.com/acme/app", clonePath: "app" }],
};
const user = { id: "sa_bot", kind: "service" } as never;

function makeOps(token: () => Promise<string | undefined>) {
  const baked: unknown[] = [];
  const jobs = new JobService();
  const ops = new SandboxOps({
    runtime: {
      prebuild: async (_spec: unknown, options: unknown) => {
        baked.push(options);
        return { ref: "snap", hash: "h" };
      },
    },
    control: {
      gitCredentials: { token },
      defaultOrg: { isServerAdmin: () => false },
    },
    jobs,
  } as never);
  return { ops, jobs, baked };
}

async function settled(jobs: InstanceType<typeof JobService>, id: string) {
  for (let i = 0; i < 100; i++) {
    const job = jobs.get(id);
    if (job.status !== "queued" && job.status !== "running") return job;
    await Bun.sleep(5);
  }
  throw new Error("job did not settle");
}

describe("SandboxOps.startPrebuild", () => {
  test("resolves the creator's token inside the job", async () => {
    let resolved = 0;
    const { ops, jobs, baked } = makeOps(async () => {
      resolved++;
      return "ghs_fresh";
    });
    const job = ops.startPrebuild(user, spec as never);
    // Queued, not yet resolved: the request did no GitHub call.
    expect(job.status).toMatch(/queued|running/);
    expect((await settled(jobs, job.id)).status).toBe("succeeded");
    expect(resolved).toBe(1);
    expect(baked[0]).toMatchObject({
      githubToken: "ghs_fresh",
      createdBy: "sa_bot",
    });
  });

  test("a failing resolver fails the job, not the request", async () => {
    const { ops, jobs, baked } = makeOps(async () => {
      throw new Error("mint exploded");
    });
    const job = ops.startPrebuild(user, spec as never);
    const done = await settled(jobs, job.id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("mint exploded");
    expect(baked).toEqual([]);
  });
});
