/**
 * `/auth/me` is the console's session check: a person whose GitHub token
 * GitHub no longer accepts is signed out (401, session cookie deleted) with a
 * reason the console can show.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import type { AuthUser } from "../control/index.ts";
import { config } from "../shared/lib/config.ts";
import type { ServerContainer } from "./container.ts";

const person = (id: string): AuthUser => ({
  id,
  username: id,
  email: `${id}@x.test`,
  avatarUrl: "",
  kind: "human",
  scope: "full",
});

let previousMode: typeof config.server.mode;
let app: Elysia;
let jwt: Record<string, string>;
/** Whose GitHub token GitHub still accepts. */
const accepted = new Set(["alice"]);

beforeAll(async () => {
  previousMode = config.server.mode;
  config.server.mode = "production";
  const { signJwt, verifyJwt } = await import("../control/index.ts");
  jwt = {
    alice: await signJwt(person("alice")),
    bob: await signJwt(person("bob")),
  };
  const container = {
    control: {
      authService: { verifySession: verifyJwt },
      gitHubTokens: { ensureValid: async (id: string) => accepted.has(id) },
      defaultOrg: { isServerAdmin: () => false },
    },
  } as unknown as ServerContainer;
  const { createAuthRoutes } = await import("./auth.routes.ts");
  app = new Elysia().use(createAuthRoutes(container)) as unknown as Elysia;
});

afterAll(() => {
  config.server.mode = previousMode;
});

function me(token?: string) {
  return app.handle(
    new Request("http://localhost/auth/me", {
      headers: token ? { cookie: `sandbox_token=${token}` } : {},
    }),
  );
}

describe("GET /auth/me", () => {
  test("a person GitHub still accepts is signed in", async () => {
    const res = await me(jwt.alice);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe("alice");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("a revoked GitHub token signs the person out, with the reason", async () => {
    const res = await me(jwt.bob);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "GITHUB_SESSION_EXPIRED",
    );
    expect(res.headers.get("set-cookie")).toContain("sandbox_token=;");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  test("a bad or missing JWT is a plain 401", async () => {
    const bad = await me("not-a-jwt");
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { error: string }).error).toBe(
      "UNAUTHORIZED",
    );
    expect((await me()).status).toBe(401);
  });
});
