/**
 * The sandbox state routes never return `generated` (agent password, pod IP,
 * ssh host keys): `GET /v1/sandboxes/:id` and `POST .../resume` alike.
 */
import { beforeAll, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { SandboxError } from "../shared/errors.ts";
import type { ServerContainer } from "./container.ts";

const state = {
  id: "box",
  status: "running",
  urls: [],
  processes: [],
  generated: { agentPassword: "pw-secret", podIp: "10.0.0.9" },
};

let app: Elysia;

beforeAll(async () => {
  const container = {
    runtime: {
      getLabels: () => ({ metadata: {}, annotations: {} }),
      get: async () => state,
    },
    sandboxOps: { resume: async () => state },
    jobs: {},
    idle: {},
    toolboxOps: {},
    control: {
      authService: {
        resolveToken: async () => ({
          id: "u",
          username: "u",
          email: "",
          avatarUrl: "",
        }),
      },
      canAccessSandbox: () => true,
      defaultOrg: { isServerAdmin: () => false },
    },
  } as unknown as ServerContainer;
  const { createV1Routes } = await import("./v1.routes.ts");
  app = new Elysia()
    .onError(({ error, set }) => {
      if (error instanceof SandboxError) set.status = error.statusCode;
    })
    .use(createV1Routes(container)) as unknown as Elysia;
});

test("GET and resume answer the sandbox without its generated block", async () => {
  for (const [method, path] of [
    ["GET", "/v1/sandboxes/box"],
    ["POST", "/v1/sandboxes/box/resume"],
  ] as const) {
    const res = await app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          authorization: "Bearer t",
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        body: method === "POST" ? "{}" : undefined,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe("box");
    expect(body).not.toHaveProperty("generated");
    expect(JSON.stringify(body)).not.toContain("pw-secret");
  }
});
