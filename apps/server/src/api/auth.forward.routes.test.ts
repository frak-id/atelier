/**
 * `/auth/forward` and `/auth/wake` at the HTTP level: forward-auth applies the
 * sandbox access rule to a sandbox's tool hosts, and the unauthenticated wake
 * check only ever resumes a sandbox for one of its preview hosts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { AuthUser } from "../control/index.ts";
import { config } from "../shared/lib/config.ts";
import type { ServerContainer } from "./container.ts";

process.env.ATELIER_SERVER_MODE = "production";

const BASE = "atelier.test";
const OWNER = "atelier.dev/owner-id";

const alice: AuthUser = {
  id: "alice",
  username: "alice",
  email: "a@x.test",
  avatarUrl: "",
  kind: "human",
  scope: "full",
};
const bob: AuthUser = { ...alice, id: "bob", username: "bob" };

let previousMode: typeof config.server.mode;
let previousBase: string;
let app: Elysia;
let cookies: Record<string, string>;
const wakes: string[] = [];
const statuses: Record<string, string> = { box: "paused", other: "paused" };

beforeAll(async () => {
  previousMode = config.server.mode;
  previousBase = config.domain.baseDomain;
  config.server.mode = "production";
  config.domain.baseDomain = BASE;
  const { signJwt, verifyJwt } = await import("../control/index.ts");
  cookies = {
    alice: `sandbox_token=${await signJwt(alice)}`,
    bob: `sandbox_token=${await signJwt(bob)}`,
  };
  const labels: Record<string, { metadata: Record<string, string> }> = {
    box: { metadata: { [OWNER]: "alice" } },
    other: { metadata: { [OWNER]: "alice" } },
  };
  const container = {
    runtime: {
      getStatus: (id: string) => statuses[id],
      getLabels: (id: string) =>
        labels[id] && { ...labels[id], annotations: {} },
      // `box` serves a preview on `web`, a login-protected `code` tool.
      getPreviewHosts: (id: string) =>
        id === "box" ? [`web-box.${BASE}`] : id === "other" ? [] : undefined,
    },
    sandboxOps: {
      wake: (id: string) => {
        wakes.push(id);
        return true;
      },
    },
    control: {
      authService: { verifySession: verifyJwt },
      canAccessSandbox: (userId: string, l: { metadata?: object }) =>
        (l.metadata as Record<string, string>)[OWNER] === userId,
      defaultOrg: { isServerAdmin: () => false },
    },
  } as unknown as ServerContainer;
  const { createAuthRoutes } = await import("./auth.routes.ts");
  app = new Elysia().use(createAuthRoutes(container)) as unknown as Elysia;
});

afterAll(() => {
  config.server.mode = previousMode;
  config.domain.baseDomain = previousBase;
});

function call(path: string, host: string, cookie?: string) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      headers: {
        "x-forwarded-host": host,
        "x-forwarded-proto": "https",
        ...(cookie ? { cookie } : {}),
      },
    }),
  );
}

describe("GET /auth/forward", () => {
  test("a signed-in user without access to the sandbox gets 403", async () => {
    const res = await call("/auth/forward", `code-box.${BASE}`, cookies.bob);
    expect(res.status).toBe(403);
    expect(wakes).toEqual([]);
  });

  test("a user with access passes, and a paused sandbox wakes", async () => {
    const res = await call("/auth/forward", `code-box.${BASE}`, cookies.alice);
    expect(res.status).toBe(503);
    expect(wakes).toEqual(["box"]);
    statuses.box = "running";
    const up = await call("/auth/forward", `code-box.${BASE}`, cookies.alice);
    expect(up.status).toBe(200);
    statuses.box = "paused";
  });

  test("a host that is no known sandbox keeps the signed-in rule", async () => {
    const res = await call("/auth/forward", `code-nope.${BASE}`, cookies.bob);
    expect(res.status).toBe(200);
    const console = await call("/auth/forward", `atelier.${BASE}`, cookies.bob);
    expect(console.status).toBe(200);
  });

  test("without a session it is still a 401", async () => {
    const res = await call("/auth/forward", `code-box.${BASE}`);
    expect(res.status).toBe(401);
  });
});

describe("GET /auth/wake", () => {
  test("a preview host of a paused sandbox resumes it", async () => {
    wakes.length = 0;
    const res = await call("/auth/wake", `web-box.${BASE}`);
    expect(res.status).toBe(503);
    expect(wakes).toEqual(["box"]);
  });

  test("a running sandbox's preview host passes", async () => {
    statuses.box = "running";
    const res = await call("/auth/wake", `web-box.${BASE}:443`);
    expect(res.status).toBe(200);
    statuses.box = "paused";
  });

  test("a host that is not one of its preview ports is a 404, no resume", async () => {
    wakes.length = 0;
    // The login-protected tool, a made-up name, a sandbox with no preview,
    // an unknown sandbox and a foreign host: all the same answer.
    for (const host of [
      `code-box.${BASE}`,
      `anything-box.${BASE}`,
      `web-other.${BASE}`,
      `web-gone.${BASE}`,
      "web-box.evil.example",
    ]) {
      const res = await call("/auth/wake", host);
      expect(res.status).toBe(404);
    }
    expect(wakes).toEqual([]);
  });
});
