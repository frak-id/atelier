/**
 * The `repo` create sugar through the real `/v1` routes, a real RuntimeService (mock backend) and JobService.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrebuildSpec, SandboxSpec } from "@atelier/spec";
import { Elysia } from "elysia";
import type { AuthUser } from "../control/index.ts";

process.env.ATELIER_SERVER_MODE = "mock";

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
  const { KubernetesBackend } = await import("../runtime/backend/index.ts");
  const { SandboxError, UnauthorizedError } = await import(
    "../shared/errors.ts"
  );
  const { createV1Routes } = await import("./v1.routes.ts");

  runtime = new RuntimeService({
    backend: new KubernetesBackend(),
    sandboxes: new stores.InMemorySandboxStore(),
    snapshots: new stores.InMemorySnapshotStore(),
    toolsets: new stores.InMemoryToolsetStore(),
    sandboxToolsetRefs: new stores.InMemorySandboxToolsetRefStore(),
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
  runtime.prebuild = (async (spec: PrebuildSpec) => {
    bakedFor.push(spec);
    return { ref: "snap:fresh" };
  }) as never;
  jobs = new JobService();
  const control = createControlContainer();
  const container = {
    runtime,
    jobs,
    control: {
      ...control,
      authService: {
        resolveToken: async (token?: string) => {
          const user = token ? users[token] : undefined;
          if (!user) throw new UnauthorizedError();
          return user;
        },
      },
    },
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

  test("repo with prebuild or a snapshot source is a 400", async () => {
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
