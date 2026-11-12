/**
 * A console session (JWT) lives only while Atelier holds the person's GitHub
 * token: dropping a token GitHub rejected signs the person out everywhere.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../shared/lib/config.ts";
import { AuthService, signJwt } from "./auth.ts";
import type { User } from "./types.ts";

const users: Record<string, Partial<User>> = {
  alice: { id: "alice", kind: "human", githubAccessToken: "gho_a" },
  bob: { id: "bob", kind: "human" },
  sa_bot: { id: "sa_bot", kind: "service" },
};

const auth = new AuthService({
  apiKeyService: {} as never,
  userService: { getById: (id) => users[id] as User | undefined },
});

const jwtFor = (id: string) =>
  signJwt({ id, username: id, avatarUrl: "", email: `${id}@x.test` });

let previousMode: typeof config.server.mode;

beforeAll(() => {
  previousMode = config.server.mode;
  config.server.mode = "production";
});

afterAll(() => {
  config.server.mode = previousMode;
});

describe("AuthService.verifySession", () => {
  test("a person holding a GitHub token has a session", async () => {
    expect((await auth.verifySession(await jwtFor("alice")))?.id).toBe("alice");
    expect((await auth.resolveToken(await jwtFor("alice"))).id).toBe("alice");
  });

  test("a person whose GitHub token was dropped has none", async () => {
    expect(await auth.verifySession(await jwtFor("bob"))).toBeNull();
    await expect(auth.resolveToken(await jwtFor("bob"))).rejects.toThrow(
      "Invalid or expired token",
    );
  });

  test("an unknown user, a service account and a bad JWT have none", async () => {
    expect(await auth.verifySession(await jwtFor("ghost"))).toBeNull();
    expect(await auth.verifySession(await jwtFor("sa_bot"))).toBeNull();
    expect(await auth.verifySession("not-a-jwt")).toBeNull();
  });

  test("an auth-bypassed server keeps its local session", async () => {
    config.server.mode = "local";
    try {
      expect(await auth.verifySession("anything")).not.toBeNull();
    } finally {
      config.server.mode = "production";
    }
  });
});
