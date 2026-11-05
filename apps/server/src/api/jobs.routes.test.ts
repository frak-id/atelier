/**
 * The `/v1/jobs` feed is scoped (api/job-access.ts): a caller sees the jobs
 * they started, those on sandboxes they may access, and everything when they
 * are a server admin; cancel is for the owner or a server admin.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { JobRecord } from "../runtime/index.ts";
import { SandboxError, UnauthorizedError } from "../shared/errors.ts";
import type { ServerContainer } from "./container.ts";
import { ownedJobMetadata } from "./job-access.ts";

const OWNER = "atelier.dev/owner-id";

function job(id: string, fields: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    kind: "prebuild",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...fields,
  };
}

const rows: JobRecord[] = [
  job("alice-bake", { metadata: { owner: "alice" } }),
  job("bob-bake", { metadata: { owner: "bob" } }),
  job("system-bake", { target: "github.com/acme/app" }),
  job("on-alice-box", {
    kind: "sandbox-create",
    metadata: { sandboxId: "alice-box", owner: "alice" },
  }),
  job("pause-alice-box", { kind: "sandbox-pause", target: "alice-box" }),
  job("image", { kind: "image-build", target: "dev-base" }),
];

const canceled: string[] = [];
const listeners: Array<(job: JobRecord) => void> = [];
let app: Elysia;

beforeAll(async () => {
  const jobs = {
    list: () => rows,
    get: (id: string) => {
      const found = rows.find((j) => j.id === id);
      if (!found) throw new SandboxError("no job", "NOT_FOUND", 404);
      return found;
    },
    getLog: () => "log line",
    cancel: (id: string) => {
      canceled.push(id);
      return rows.find((j) => j.id === id);
    },
    subscribe: (_signal: AbortSignal, listener: (job: JobRecord) => void) => {
      listeners.push(listener);
      for (const j of rows) listener(j);
    },
  };
  const labels: Record<string, { metadata: Record<string, string> }> = {
    "alice-box": { metadata: { [OWNER]: "alice" } },
  };
  const container = {
    jobs,
    runtime: {
      getLabels: (id: string) =>
        labels[id] && { ...labels[id], annotations: {} },
    },
    control: {
      authService: {
        resolveToken: async (token?: string) => {
          if (!token) throw new UnauthorizedError();
          return { id: token, username: token, email: "", avatarUrl: "" };
        },
      },
      canAccessSandbox: (userId: string, l: { metadata?: object }) =>
        (l.metadata as Record<string, string>)[OWNER] === userId,
      defaultOrg: { isServerAdmin: (userId: string) => userId === "root" },
    },
  } as unknown as ServerContainer;
  const { createV1Routes } = await import("./v1.routes.ts");
  app = new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof SandboxError) {
        set.status = error.statusCode;
        return { error: error.code };
      }
    })
    .use(createV1Routes(container)) as unknown as Elysia;
});

function request(token: string, method: string, path: string) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

async function visibleIds(token: string): Promise<string[]> {
  const res = await request(token, "GET", "/v1/jobs");
  expect(res.status).toBe(200);
  return ((await res.json()) as JobRecord[]).map((j) => j.id).sort();
}

describe("GET /v1/jobs", () => {
  test("a user sees their own jobs, their sandboxes' jobs and image builds", async () => {
    expect(await visibleIds("alice")).toEqual([
      "alice-bake",
      "image",
      "on-alice-box",
      "pause-alice-box",
    ]);
    expect(await visibleIds("bob")).toEqual(["bob-bake", "image"]);
  });

  test("a server admin sees all of them", async () => {
    expect(await visibleIds("root")).toHaveLength(rows.length);
  });

  test("the limit applies after the scoping", async () => {
    const res = await request("bob", "GET", "/v1/jobs?limit=1");
    expect(((await res.json()) as JobRecord[]).map((j) => j.id)).toEqual([
      "bob-bake",
    ]);
  });
});

describe("GET /v1/jobs/:id and /logs", () => {
  test("another user's job is a 404, same as an unknown one", async () => {
    for (const path of ["/v1/jobs/alice-bake", "/v1/jobs/alice-bake/logs"]) {
      expect((await request("bob", "GET", path)).status).toBe(404);
    }
    expect((await request("bob", "GET", "/v1/jobs/nope")).status).toBe(404);
  });

  test("the owner, a sandbox member and an admin read it", async () => {
    for (const token of ["alice", "root"]) {
      const res = await request(token, "GET", "/v1/jobs/alice-bake/logs");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "running", log: "log line" });
    }
    const onSandbox = await request("alice", "GET", "/v1/jobs/pause-alice-box");
    expect(onSandbox.status).toBe(200);
  });
});

describe("POST /v1/jobs/:id/cancel", () => {
  test("a stranger gets a 404 and nothing is canceled", async () => {
    const res = await request("bob", "POST", "/v1/jobs/alice-bake/cancel");
    expect(res.status).toBe(404);
    expect(canceled).toEqual([]);
  });

  test("a user who only sees the job (image build) gets a 403", async () => {
    const res = await request("bob", "POST", "/v1/jobs/image/cancel");
    expect(res.status).toBe(403);
    expect(canceled).toEqual([]);
  });

  test("the owner and a server admin cancel", async () => {
    expect(
      (await request("alice", "POST", "/v1/jobs/alice-bake/cancel")).status,
    ).toBe(200);
    expect(
      (await request("root", "POST", "/v1/jobs/bob-bake/cancel")).status,
    ).toBe(200);
    expect(canceled).toEqual(["alice-bake", "bob-bake"]);
  });

  test("an ownerless job is canceled by who may access its sandbox", async () => {
    const res = await request(
      "alice",
      "POST",
      "/v1/jobs/pause-alice-box/cancel",
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /v1/jobs/events", () => {
  test("streams only the jobs the caller may see", async () => {
    const res = await request("bob", "GET", "/v1/jobs/events");
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    // Replayed non-terminal jobs arrive first; read until the feed idles.
    while (reader && !text.includes("image")) {
      const { value, done } = await reader.read();
      if (done) break;
      text +=
        typeof value === "string" ? value : decoder.decode(value as Uint8Array);
    }
    await reader?.cancel();
    expect(text).toContain("bob-bake");
    expect(text).not.toContain("alice-bake");
    expect(text).not.toContain("on-alice-box");
  });
});

describe("ownedJobMetadata", () => {
  test("sets the owner and drops caller-supplied server-owned keys", () => {
    expect(
      ownedJobMetadata("alice", {
        repo: "acme/app",
        owner: "bob",
        sandboxId: "alice-box",
        forkOf: "x",
      }),
    ).toEqual({ repo: "acme/app", owner: "alice" });
    expect(ownedJobMetadata(undefined)).toBeUndefined();
    expect(ownedJobMetadata("alice")).toEqual({ owner: "alice" });
  });
});
