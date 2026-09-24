import { beforeAll, describe, expect, test } from "bun:test";
import { NotFoundError, ValidationError } from "../shared/errors.ts";
import type * as GitHubRepos from "./github-repos.ts";
import type { User } from "./types.ts";

// `github-repos.ts` transitively loads the server config, which is frozen at
// first import and shared by every test file in the run. Same convention as
// `runtime.lifecycle.test.ts`: pin mock mode BEFORE anything loads it, and
// import lazily. (The service's own mode is injected per test anyway.)
process.env.ATELIER_SERVER_MODE = "mock";
let GitHubRepoService: typeof GitHubRepos.GitHubRepoService;
let GitHubUpstreamError: typeof GitHubRepos.GitHubUpstreamError;

beforeAll(async () => {
  ({ GitHubRepoService, GitHubUpstreamError } = await import(
    "./github-repos.ts"
  ));
});

function user(id: string, token?: string): User {
  return {
    id,
    username: `u${id}`,
    email: `${id}@x`,
    githubAccessToken: token,
    createdAt: "",
    lastLoginAt: "",
  };
}

function rawRepo(i: number, extra: Record<string, unknown> = {}) {
  return {
    full_name: `org/repo-${i}`,
    name: `repo-${i}`,
    owner: { login: "org", avatar_url: "a" },
    clone_url: `https://github.com/org/repo-${i}.git`,
    html_url: `https://github.com/org/repo-${i}`,
    description: null,
    private: false,
    fork: false,
    archived: false,
    default_branch: "main",
    language: "TypeScript",
    pushed_at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), { status, headers });
}

/** A service over a routed fake `fetch`, recording every call + its token. */
function setup(
  route: (url: URL) => Response,
  users: User[] = [user("1", "tok-1"), user("2", "tok-2")],
) {
  const calls: { url: URL; auth: string | null }[] = [];
  let clock = 0;
  const service = new GitHubRepoService({
    userService: { getById: (id) => users.find((u) => u.id === id) },
    mode: () => "real",
    now: () => clock,
    fetch: async (input, init) => {
      const url = new URL(input);
      calls.push({
        url,
        auth: new Headers(init?.headers).get("authorization"),
      });
      return route(url);
    },
  });
  return {
    service,
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("GitHubRepoService.listRepos", () => {
  test("uses only the caller's own token; no token means not connected", async () => {
    const { service, calls } = setup(
      () => json([rawRepo(1)]),
      [user("1", "tok-1"), user("2")],
    );
    const mine = await service.listRepos("1");
    expect(mine.connected).toBe(true);
    expect(mine.repos.map((r) => r.fullName)).toEqual(["org/repo-1"]);
    expect(calls[0]?.auth).toBe("Bearer tok-1");

    // user 2 has no token: must NOT borrow user 1's
    const theirs = await service.listRepos("2");
    expect(theirs).toEqual({ connected: false, repos: [], truncated: false });
    expect(calls).toHaveLength(1);
  });

  test("paginates until a short page and maps fields", async () => {
    const { service, calls } = setup((url) => {
      const page = Number(url.searchParams.get("page"));
      const size = page === 1 ? 100 : 3;
      return json(
        Array.from({ length: size }, (_, i) =>
          rawRepo(page * 1000 + i, { private: i === 0 }),
        ),
      );
    });
    const list = await service.listRepos("1");
    expect(list.repos).toHaveLength(103);
    expect(list.truncated).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url.searchParams.get("sort")).toBe("pushed");
    expect(list.repos[0]).toMatchObject({
      fullName: "org/repo-1000",
      cloneUrl: "https://github.com/org/repo-1000.git",
      defaultBranch: "main",
      private: true,
    });
  });

  test("flags truncation at the page cap", async () => {
    const { service, calls } = setup(() =>
      json(Array.from({ length: 100 }, (_, i) => rawRepo(i))),
    );
    const list = await service.listRepos("1");
    expect(calls).toHaveLength(5);
    expect(list.truncated).toBe(true);
  });

  test("caches per user for a minute; refresh bypasses", async () => {
    const { service, calls, advance } = setup(() => json([rawRepo(1)]));
    await service.listRepos("1");
    await service.listRepos("1");
    expect(calls).toHaveLength(1);
    await service.listRepos("2");
    expect(calls).toHaveLength(2);
    await service.listRepos("1", { refresh: true });
    expect(calls).toHaveLength(3);
    advance(61_000);
    await service.listRepos("1");
    expect(calls).toHaveLength(4);
  });

  test("maps upstream failures to a 502 with a useful message", async () => {
    const limited = setup(() =>
      json({}, 403, { "x-ratelimit-remaining": "0" }),
    );
    const err = await limited.service.listRepos("1").catch((e) => e);
    expect(err).toBeInstanceOf(GitHubUpstreamError);
    expect(err.statusCode).toBe(502);
    expect(err.message).toContain("rate limit");

    const revoked = setup(() => json({}, 401));
    const err2 = await revoked.service.listRepos("1").catch((e) => e);
    expect(err2.message).toContain("sign in with GitHub again");
  });
});

describe("GitHubRepoService.inspectRepo", () => {
  test("default branch first + setup steps from root files", async () => {
    const { service, calls } = setup((url) => {
      if (url.pathname === "/repos/org/app")
        return json(
          rawRepo(0, { full_name: "org/app", default_branch: "dev" }),
        );
      if (url.pathname === "/repos/org/app/branches")
        return json([{ name: "main" }, { name: "dev" }, { name: "feat" }]);
      if (url.pathname === "/repos/org/app/contents/")
        return json([
          { name: "package.json", type: "file" },
          { name: "pnpm-lock.yaml", type: "file" },
          { name: "Cargo.toml", type: "dir" },
        ]);
      return json({}, 404);
    });
    const out = await service.inspectRepo("1", "org", "app");
    expect(out.defaultBranch).toBe("dev");
    expect(out.branches).toEqual(["dev", "main", "feat"]);
    expect(out.suggestedBuild).toEqual(["pnpm install --frozen-lockfile"]);
    const contents = calls.find((c) => c.url.pathname.endsWith("/contents/"));
    expect(contents?.url.searchParams.get("ref")).toBe("dev");
  });

  test("an empty repo (contents 404) just suggests nothing", async () => {
    const { service } = setup((url) =>
      url.pathname === "/repos/org/empty"
        ? json(rawRepo(0, { full_name: "org/empty" }))
        : url.pathname.endsWith("/branches")
          ? json([])
          : json({ message: "This repository is empty." }, 404),
    );
    const out = await service.inspectRepo("1", "org", "empty");
    expect(out.suggestedBuild).toEqual([]);
    expect(out.branches).toEqual(["main"]);
  });

  test("caches per repo case-insensitively but per branch case-sensitively", async () => {
    const { service, calls } = setup((url) =>
      url.pathname.endsWith("/branches")
        ? json([])
        : url.pathname.endsWith("/contents/")
          ? json([])
          : json(rawRepo(0, { full_name: "org/app" })),
    );
    await service.inspectRepo("1", "org", "app", "Feat");
    const perInspect = calls.length;
    await service.inspectRepo("1", "ORG", "App", "Feat");
    expect(calls).toHaveLength(perInspect);
    await service.inspectRepo("1", "org", "app", "feat");
    expect(calls).toHaveLength(perInspect * 2);
  });

  test("rejects path-injection names and unknown repos", async () => {
    const { service, calls } = setup(() => json({}, 404));
    await expect(service.inspectRepo("1", "org", "../x")).rejects.toThrow(
      ValidationError,
    );
    expect(calls).toHaveLength(0);
    await expect(service.inspectRepo("1", "org", "nope")).rejects.toThrow(
      NotFoundError,
    );
  });

  test("mock mode serves the fixture without touching the network", async () => {
    let fetched = false;
    const service = new GitHubRepoService({
      userService: { getById: () => undefined },
      mode: () => "mock",
      fetch: async () => {
        fetched = true;
        return json([]);
      },
    });
    const list = await service.listRepos("1");
    expect(list.connected).toBe(true);
    expect(list.repos.length).toBeGreaterThan(0);
    const out = await service.inspectRepo("1", "frak-id", "atelier");
    expect(out.suggestedBuild).toEqual(["bun install"]);
    expect(fetched).toBe(false);
  });
});
