/**
 * `resolveGitHubToken` hands out the user's OWN token only. It used to fall
 * back to the first user in the table with a token, which wrote one user's
 * OAuth token into another user's sandbox.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../../../shared/lib/config.ts";
import type { User } from "../../types.ts";
import type { UserRepository } from "./user.repository.ts";
import { UserService } from "./user.service.ts";

function mkUser(id: string, githubAccessToken?: string): User {
  return { id, username: id, githubAccessToken } as User;
}

const byId: Record<string, User> = {
  alice: mkUser("alice", "gho_alice"),
  bob: mkUser("bob"),
};
const repo = { getById: (id: string) => byId[id] } as UserRepository;
const service = new UserService(repo);

let previousMode: typeof config.server.mode;
let previousToken: string | undefined;

beforeAll(() => {
  previousMode = config.server.mode;
  previousToken = process.env.ATELIER_GITHUB_TOKEN;
  delete process.env.ATELIER_GITHUB_TOKEN;
});

afterAll(() => {
  config.server.mode = previousMode;
  if (previousToken === undefined) delete process.env.ATELIER_GITHUB_TOKEN;
  else process.env.ATELIER_GITHUB_TOKEN = previousToken;
});

describe("UserService.resolveGitHubToken", () => {
  test("returns the user's own token", () => {
    config.server.mode = "production";
    expect(service.resolveGitHubToken("alice")).toBe("gho_alice");
  });

  test("a user without a token never gets another user's", () => {
    config.server.mode = "production";
    expect(service.resolveGitHubToken("bob")).toBeUndefined();
    expect(service.resolveGitHubToken("nobody")).toBeUndefined();
  });

  test("auth bypass uses the host token, never a stored one", () => {
    config.server.mode = "local";
    expect(service.resolveGitHubToken("alice")).toBeUndefined();
    process.env.ATELIER_GITHUB_TOKEN = "gho_host";
    expect(service.resolveGitHubToken("bob")).toBe("gho_host");
    delete process.env.ATELIER_GITHUB_TOKEN;
  });
});
