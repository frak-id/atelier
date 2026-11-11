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

function makeContainer(
  options: {
    tracking?: boolean;
    stale?: unknown[];
    token?: (userId: string) => Promise<string | undefined>;
  } = {},
) {
  const probed: Array<string | undefined> = [];
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
      prebuilds: {
        // Like the real one: the resolver is called per prebuild creator.
        findStale: async (
          resolve: (id: string) => Promise<string | undefined>,
        ) => {
          for (const s of options.stale ?? stale) {
            const createdBy = (s as { createdBy?: string }).createdBy;
            if (createdBy) probed.push(await resolve(createdBy));
          }
          return options.stale ?? stale;
        },
      },
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
      gitCredentials: { token: options.token ?? (async () => undefined) },
    },
  };
  return { container, jobs, rebuilt, pruned, release, probed };
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
    // The job resolved the creator's token itself (below: not the probe's).
    await Promise.resolve();
    expect(rebuilt[0]).toMatchObject([spec, { createdBy: "alice" }]);
    release[0]?.();
  });

  test("findStale gets the real token resolver; the job resolves its own token again", async () => {
    const resolved: string[] = [];
    let n = 0;
    const { container, rebuilt, probed, release } = makeContainer({
      token: async (userId) => {
        resolved.push(userId);
        return `tok-${++n}`;
      },
    });
    expect(await dispatchStalePrebuilds(container as never)).toBe(1);
    // Probe: first call. Job: a second call, whose token is what bakes
    // (the probe's token may have expired while the job queued).
    await new Promise((r) => setTimeout(r, 0));
    expect(probed).toEqual(["tok-1"]);
    expect(resolved).toEqual(["alice", "alice"]);
    expect(rebuilt[0]).toMatchObject([spec, { githubToken: "tok-2" }]);
    release[0]?.();
  });

  test("a creator-less rebuild runs without a token and without resolving", async () => {
    const resolved: string[] = [];
    const { container, rebuilt, release } = makeContainer({
      stale: [{ ref: "r", hash: "h2", spec, githubToken: "probe" }],
      token: async (userId) => {
        resolved.push(userId);
        return "x";
      },
    });
    expect(await dispatchStalePrebuilds(container as never)).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toEqual([]);
    expect(rebuilt[0]).toMatchObject([spec, { githubToken: undefined }]);
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
