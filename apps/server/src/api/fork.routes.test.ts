/**
 * `POST /v1/sandboxes/:id/fork` through the real route, real RuntimeService
 * (mock mode) and JobService: the id in the 202 resolves at once as a
 * `creating` sandbox, and a source that cannot be snapshotted is refused
 * before any job exists.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxSpec } from "@atelier/spec";
import { Elysia } from "elysia";

process.env.ATELIER_SERVER_MODE = "mock";

const spec: SandboxSpec = {
  source: { image: "registry.test/base:1" },
  resources: { vcpus: 1, memoryMb: 512 },
};

let dataDir: string;
let app: Elysia;
let runtime: InstanceType<typeof import("../runtime/index.ts").RuntimeService>;
let jobs: InstanceType<typeof import("../runtime/index.ts").JobService>;
let sandboxes: InstanceType<
  typeof import("../runtime/store.ts").InMemorySandboxStore
>;
let releaseSnapshot: () => void = () => {};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "atelier-fork-routes-"));
  process.env.DATA_DIR = dataDir;
  process.env.MIGRATIONS_DIR ??= join(import.meta.dir, "../../drizzle");
  const { initDatabase } = await import("../control/db/client.ts");
  await initDatabase();
  const { createControlContainer } = await import("../control/index.ts");
  const { RuntimeService, JobService } = await import("../runtime/index.ts");
  const stores = await import("../runtime/store.ts");
  const { KubernetesBackend } = await import("../runtime/backend/index.ts");
  const { SandboxError } = await import("../shared/errors.ts");
  const { createV1Routes } = await import("./v1.routes.ts");

  const backend = new KubernetesBackend();
  const gate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  // The fork's snapshot cannot finish until the test lets it.
  backend.volumes.snapshot = async () => {
    await gate;
  };
  sandboxes = new stores.InMemorySandboxStore();
  runtime = new RuntimeService({
    backend,
    sandboxes,
    snapshots: new stores.InMemorySnapshotStore(),
    toolsets: new stores.InMemoryToolsetStore(),
    sandboxToolsetRefs: new stores.InMemorySandboxToolsetRefStore(),
  });
  jobs = new JobService();
  const container = {
    runtime,
    jobs,
    control: createControlContainer(),
  } as unknown as Parameters<typeof createV1Routes>[0];
  app = new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof SandboxError) {
        set.status = error.statusCode;
        return { error: error.code, message: error.message };
      }
    })
    .use(createV1Routes(container)) as unknown as Elysia;
});

afterAll(async () => {
  releaseSnapshot();
  await rm(dataDir, { recursive: true, force: true });
});

const headers = {
  authorization: "Bearer test",
  "content-type": "application/json",
};

describe("POST /v1/sandboxes/:id/fork", () => {
  test("the copy's id resolves as `creating` right after the 202", async () => {
    await runtime.create(spec, { id: "src" });

    const res = await app.handle(
      new Request("http://localhost/v1/sandboxes/src/fork", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "copy" }),
      }),
    );
    expect(res.status).toBe(202);
    const job = (await res.json()) as { metadata: { sandboxId: string } };
    const copyId = job.metadata.sandboxId;

    const got = await app.handle(
      new Request(`http://localhost/v1/sandboxes/${copyId}`, { headers }),
    );
    expect(got.status).toBe(200);
    expect(((await got.json()) as { status: string }).status).toBe("creating");

    // Once the snapshot may finish, the copy boots.
    releaseSnapshot();
    for (
      let i = 0;
      i < 50 && sandboxes.get(copyId)?.status !== "running";
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(sandboxes.get(copyId)?.status).toBe("running");
  });

  test("a non-snapshottable source is a 409 with no job and no record", async () => {
    await runtime.create(spec, { id: "broken" });
    sandboxes.update("broken", { status: "error" });
    const before = jobs.list().length;
    const recordsBefore = sandboxes.list().length;

    const res = await app.handle(
      new Request("http://localhost/v1/sandboxes/broken/fork", {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(409);
    expect(jobs.list()).toHaveLength(before);
    expect(sandboxes.list()).toHaveLength(recordsBefore);
  });

  test("an unknown source is a 404", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/sandboxes/nope/fork", {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(404);
  });
});
