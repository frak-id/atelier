/**
 * The stale-prebuild tick goes through the job feed: a rebuild per moved
 * recipe, pooled, deduped against one already queued or running, and gated by
 * `prebuild.gitTracking`.
 */
import { beforeEach, describe, expect, test } from "bun:test";

// Local mode, set before anything loads the server config.
process.env.ATELIER_SERVER_MODE = "local";

const { JobService } = await import("../runtime/jobs.service.ts");
const { useTestDatabase } = await import("../runtime/test-database.ts");
const { dispatchStalePrebuilds } = await import("./scheduler.ts");

beforeEach(() => useTestDatabase());

const spec = {
  source: { image: "registry.test/base:1" },
  repos: [{ url: "https://github.com/acme/app", clonePath: "app" }],
  metadata: { repo: "acme/app" },
};

function makeContainer(options: { tracking?: boolean } = {}) {
  const rebuilt: unknown[] = [];
  const pruned: number[] = [];
  const release: Array<() => void> = [];
  const jobs = new JobService({ concurrency: 1 });
  const stale = [
    {
      ref: "snap-old",
      hash: "h-new",
      spec,
      githubToken: "tok-alice",
      createdBy: "alice",
    },
  ];
  const container = {
    jobs,
    runtime: {
      prebuilds: { findStale: async () => stale },
      prebuild: async (s: unknown, o: unknown) => {
        rebuilt.push([s, o]);
        await new Promise<void>((resolve) => release.push(resolve));
        return { ref: "snap-new", hash: "h-new" };
      },
      pruneUnusedPrebuilds: async (keep: number) => {
        pruned.push(keep);
        return 0;
      },
    },
    control: {
      serverConfigService: {
        get: (key: string) =>
          key === "prebuild.gitTracking" ? (options.tracking ?? true) : 3,
      },
      userService: { resolveGitHubToken: () => undefined },
    },
  };
  return { container, jobs, rebuilt, pruned, release };
}

describe("dispatchStalePrebuilds", () => {
  test("a moved recipe is rebuilt as a prebuild job, then retention runs", async () => {
    const { container, jobs, rebuilt, pruned, release } = makeContainer();
    expect(await dispatchStalePrebuilds(container as never)).toBe(1);

    const [job] = jobs.list();
    expect(job).toMatchObject({
      kind: "prebuild",
      status: "running",
      target: "https://github.com/acme/app",
    });
    expect(job?.metadata?.hash).toBe("h-new");
    expect(pruned).toEqual([3]);
    // With the creator's token, so a private repo resolves.
    expect(rebuilt[0]).toMatchObject([
      spec,
      { githubToken: "tok-alice", createdBy: "alice" },
    ]);
    release[0]?.();
  });

  test("a rebuild already queued or running is not dispatched twice", async () => {
    const { container, jobs, release } = makeContainer();
    expect(await dispatchStalePrebuilds(container as never)).toBe(1);
    expect(await dispatchStalePrebuilds(container as never)).toBe(0);
    expect(jobs.list()).toHaveLength(1);
    release[0]?.();
  });

  test("rebuilds are bounded by the job pool", async () => {
    const { container, jobs, release } = makeContainer();
    // A build already holds the only slot.
    jobs.dispatch({ kind: "prebuild" }, () => new Promise(() => {}));
    expect(await dispatchStalePrebuilds(container as never)).toBe(1);
    const statuses = jobs
      .list()
      .map((j) => j.status)
      .sort();
    expect(statuses).toEqual(["queued", "running"]);
    release[0]?.();
  });

  test("git tracking off dispatches nothing", async () => {
    const { container, jobs, pruned } = makeContainer({ tracking: false });
    expect(await dispatchStalePrebuilds(container as never)).toBe(0);
    expect(jobs.list()).toHaveLength(0);
    expect(pruned).toEqual([]);
  });
});
