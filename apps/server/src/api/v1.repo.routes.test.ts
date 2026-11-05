/**
 * The `repo` create sugar through the real `/v1` routes, a real
 * RuntimeService (over the runtime test doubles) and JobService.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrebuildSpec, SandboxSpec } from "@atelier/spec";
import { Elysia } from "elysia";
import type { AuthUser } from "../control/index.ts";

// Local mode: auth bypassed. Set before anything loads the server config.
process.env.ATELIER_SERVER_MODE = "local";

const body = {
  source: { image: "registry.test/base:1" },
  resources: { vcpus: 1, memoryMb: 512 },
};

let dataDir: string;
let app: Elysia;
let runtime: InstanceType<typeof import("../runtime/index.ts").RuntimeService>;
let jobs: InstanceType<typeof import("../runtime/index.ts").JobService>;
const users: Record<string, AuthUser> = {};
/** When set, `runtime.create` records the spec instead of booting. */
let captured: SandboxSpec[] | undefined;
let bakedFor: PrebuildSpec[];
let existingBakes: unknown[];
/** When set, the fresh bake "fails" and the last good one is used. */
let fallbackWarning: string | undefined;

function mkUser(name: string): void {
  users[`tok-${name}`] = {
    id: `u-${name}`,
    username: name,
    email: `${name}@x.test`,
    avatarUrl: "",
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-repo-routes-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../drizzle");
  const { initDatabase } = await import("../control/db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../control/index.ts");
  const { RuntimeService, JobService } = await import("../runtime/index.ts");
  const stores = await import("../runtime/store.ts");
  const { fakeRuntimeDeps } = await import(
    "../runtime/runtime.test-support.ts"
  );
  const { SandboxError, UnauthorizedError } = await import(
    "../shared/errors.ts"
  );
  const { createV1Routes } = await import("./v1.routes.ts");
  const { SandboxOps } = await import("./app/sandbox-ops.ts");
  const { ToolboxOps } = await import("./app/toolbox-ops.ts");

  runtime = new RuntimeService({
    ...fakeRuntimeDeps(),
    sandboxes: new stores.DrizzleSandboxStore(),
    snapshots: new stores.DrizzleSnapshotStore(),
    toolsets: new stores.DrizzleToolsetStore(),
    sandboxToolsetRefs: new stores.DrizzleSandboxToolsetRefStore(),
  });
  const realCreate = runtime.create.bind(runtime);
  runtime.create = (async (spec: SandboxSpec, options: never) => {
    if (!captured) return realCreate(spec, options);
    captured.push(spec);
    return { id: "captured", urls: [] };
  }) as typeof runtime.create;
  existingBakes = [];
  bakedFor = [];
  runtime.listPrebuilds = (() => existingBakes) as never;
  // A spawn looks the bake up, then runs it as a job (`prebuildForSpawn`).
  runtime.cachedPrebuild = (async () => undefined) as never;
  runtime.prebuildForSpawn = (async (spec: PrebuildSpec) => {
    bakedFor.push(spec);
    return fallbackWarning
      ? { ref: "snap:last-good", hash: "h", warning: fallbackWarning }
      : { ref: "snap:fresh", hash: "h" };
  }) as never;
  jobs = new JobService();
  const control = createControlContainer();
  const appControl = {
    ...control,
    authService: {
      resolveToken: async (token?: string) => {
        const user = token ? users[token] : undefined;
        if (!user) throw new UnauthorizedError();
        return user;
      },
    },
  };
  const toolboxes = new ToolboxOps({
    runtime,
    control: appControl,
    jobs,
  } as never);
  const container = {
    runtime,
    jobs,
    control: appControl,
    sandboxOps: new SandboxOps({
      runtime,
      control: appControl,
      jobs,
      toolboxes,
      idle: { setKeepAwake: () => undefined },
    } as never),
    toolboxOps: toolboxes,
  } as unknown as Parameters<typeof createV1Routes>[0];
  app = new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof SandboxError) {
        set.status = error.statusCode;
        return { error: error.code, message: error.message };
      }
    })
    .use(createV1Routes(container)) as unknown as Elysia;
  mkUser("alice");
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function call(
  token: string,
  method: string,
  path: string,
  payload?: unknown,
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        authorization: `Bearer tok-${token}`,
        "content-type": "application/json",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }),
  );
}

/** Resolves once the job is terminal (no polling: a job listener). */
function settle(jobId: string): Promise<void> {
  const pending = (status: string) =>
    status === "running" || status === "queued";
  return new Promise((resolve) => {
    if (!pending(jobs.get(jobId).status)) return resolve();
    const stop = new AbortController();
    jobs.subscribe(stop.signal, (job) => {
      if (job.id !== jobId || pending(job.status)) return;
      stop.abort();
      resolve();
    });
  });
}

describe("`repo` on the create body", () => {
  const repo = { url: "https://github.com/acme/app", branch: "dev" };

  test("a matching bake is reused as the snapshot source", async () => {
    captured = [];
    existingBakes = [
      {
        ref: "snap:cached",
        spec: {
          source: { image: "registry.test/base:1" },
          repos: [{ url: "git@github.com:acme/app.git", branch: "dev" }],
        },
      },
    ];
    bakedFor.length = 0;
    const res = await call("alice", "POST", "/v1/sandboxes", { ...body, repo });
    expect(res.status).toBe(202);
    await settle(((await res.json()) as { id: string }).id);
    expect(bakedFor).toHaveLength(0);
    expect(captured[0]?.source).toEqual({ snapshot: "snap:cached" });
    expect(captured[0]).not.toHaveProperty("repo");
    captured = undefined;
  });

  test("a bake on another base image is not reused", async () => {
    captured = [];
    existingBakes = [
      {
        ref: "snap:other-base",
        spec: {
          source: { image: "registry.test/other:2" },
          repos: [{ url: repo.url, branch: "dev" }],
        },
      },
    ];
    bakedFor.length = 0;
    const res = await call("alice", "POST", "/v1/sandboxes", { ...body, repo });
    expect(res.status).toBe(202);
    await settle(((await res.json()) as { id: string }).id);
    expect(bakedFor).toHaveLength(1);
    expect(bakedFor[0]?.source).toEqual({ image: "registry.test/base:1" });
    expect(captured[0]?.source).toEqual({ snapshot: "snap:fresh" });
    captured = undefined;
  });

  test("no bake: a one-repo prebuild on the image is baked", async () => {
    captured = [];
    existingBakes = [];
    bakedFor.length = 0;
    const res = await call("alice", "POST", "/v1/sandboxes", {
      ...body,
      repo,
    });
    expect(res.status).toBe(202);
    await settle(((await res.json()) as { id: string }).id);
    expect(bakedFor).toHaveLength(1);
    expect(bakedFor[0]).toMatchObject({
      source: { image: "registry.test/base:1" },
      repos: [{ url: repo.url, branch: "dev", clonePath: "app" }],
    });
    expect(captured[0]?.source).toEqual({ snapshot: "snap:fresh" });
    expect(captured[0]).not.toHaveProperty("repo");
    expect(captured[0]).not.toHaveProperty("prebuild");
    captured = undefined;
  });

  test("a failed fresh bake boots from the last good one and says so", async () => {
    captured = [];
    existingBakes = [];
    bakedFor.length = 0;
    fallbackWarning = "could not build the current prebuild";
    const res = await call("alice", "POST", "/v1/sandboxes", { ...body, repo });
    fallbackWarning = undefined;
    expect(res.status).toBe(202);
    const id = ((await res.json()) as { id: string }).id;
    await settle(id);
    expect(captured[0]?.source).toEqual({ snapshot: "snap:last-good" });
    const job = jobs.get(id);
    expect(job.status).toBe("succeeded");
    expect(job.result).toMatchObject({
      warnings: ["could not build the current prebuild"],
    });
    captured = undefined;
  });

  test("a spawn's bake is a prebuild job in the feed", async () => {
    captured = [];
    existingBakes = [];
    const res = await call("alice", "POST", "/v1/sandboxes", { ...body, repo });
    await settle(((await res.json()) as { id: string }).id);
    const kinds = jobs.list().map((job) => job.kind);
    expect(kinds).toContain("prebuild");
    captured = undefined;
  });

  test("a prebuild snapshot of the repo boots as picked, to be switched", async () => {
    captured = [];
    existingBakes = [
      {
        ref: "snap:main",
        spec: {
          source: { image: "registry.test/base:1" },
          repos: [{ url: repo.url, branch: "main", clonePath: "app" }],
        },
      },
    ];
    bakedFor.length = 0;
    const res = await call("alice", "POST", "/v1/sandboxes", {
      ...body,
      source: { snapshot: "snap:main" },
      repo,
    });
    expect(res.status).toBe(202);
    await settle(((await res.json()) as { id: string }).id);
    expect(bakedFor).toHaveLength(0);
    expect(captured[0]?.source).toEqual({ snapshot: "snap:main" });
    captured = undefined;
  });

  test("repo with prebuild, or a snapshot that is no prebuild of it, is a 400", async () => {
    const withPrebuild = await call("alice", "POST", "/v1/sandboxes", {
      ...body,
      repo,
      prebuild: { source: { image: "registry.test/base:1" } },
    });
    expect(withPrebuild.status).toBe(400);
    const withSnapshot = await call("alice", "POST", "/v1/sandboxes", {
      ...body,
      source: { snapshot: "snap:x" },
      repo,
    });
    expect(withSnapshot.status).toBe(400);
  });
});
