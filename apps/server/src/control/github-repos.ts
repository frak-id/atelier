/**
 * The caller's GitHub repositories, for the console's quick-prebuild flow:
 * "list the repos I can access, and bake a prebuild for one in a click".
 *
 * Policy, not mechanism: this reads the user's own OAuth token (identity),
 * so it lives in control/. The token is ALWAYS the caller's own. It never goes
 * through `UserService.resolveGitHubToken`'s "any user with a token"
 * fallback, which is fine for cloning a repo but would list another user's
 * private repositories here.
 *
 * Mock mode serves a fixed fixture so the whole flow is demoable without
 * GitHub. Local mode uses the host token `atelier local up` injects
 * (`ATELIER_GITHUB_TOKEN`). No token at all is not an error: the listing
 * reports `connected: false` and the console explains why.
 */
import { detectSetupSteps } from "@atelier/spec/repo-prebuild";
import {
  NotFoundError,
  SandboxError,
  ValidationError,
} from "../shared/errors.ts";
import { isAuthBypassed, isMock } from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import { githubApiGet } from "./github-api.ts";
import type { UserService } from "./modules/user/index.ts";

const log = createChildLogger("github-repos");

/** 100 per page (GitHub's max) × 5 pages. Sorted by last push, so the cap
 * only drops long-dormant repos. `truncated` tells the client when it hit. */
const PER_PAGE = 100;
const MAX_PAGES = 5;
const LIST_TTL_MS = 60_000;
const INSPECT_TTL_MS = 60_000;
const MAX_BRANCHES = 100;
const MAX_CACHE_ENTRIES = 500;

/** One repository the caller can clone, trimmed to what the console shows. */
export interface GitHubRepo {
  /** `owner/name`, as GitHub spells it. */
  fullName: string;
  owner: string;
  name: string;
  /** https clone URL, which is what the prebuild's `repos[].url` gets. */
  cloneUrl: string;
  htmlUrl: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  defaultBranch: string;
  language: string | null;
  /** ISO timestamp of the last push, or null for an empty repo. */
  pushedAt: string | null;
  ownerAvatarUrl: string;
}

export interface GitHubRepoList {
  /** False when the caller has no GitHub token. `repos` is then empty. */
  connected: boolean;
  repos: GitHubRepo[];
  /** True when more repos exist than the listing cap returned. */
  truncated: boolean;
}

/** Everything the quick-create form needs to prefill for one repo. */
export interface GitHubRepoInspection {
  fullName: string;
  cloneUrl: string;
  defaultBranch: string;
  /** Up to 100 branch names, default branch first. */
  branches: string[];
  /** Install steps detected from the root files at `ref`. They are unscoped
   * (not yet prefixed with `cd <clonePath>`). */
  suggestedBuild: string[];
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

interface RawRepo {
  full_name: string;
  name: string;
  owner: { login: string; avatar_url: string };
  clone_url: string;
  html_url: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  default_branch: string;
  language: string | null;
  pushed_at: string | null;
}

function toRepo(raw: RawRepo): GitHubRepo {
  return {
    fullName: raw.full_name,
    owner: raw.owner.login,
    name: raw.name,
    cloneUrl: raw.clone_url,
    htmlUrl: raw.html_url,
    description: raw.description,
    private: raw.private,
    fork: raw.fork,
    archived: raw.archived,
    defaultBranch: raw.default_branch,
    language: raw.language,
    pushedAt: raw.pushed_at,
    ownerAvatarUrl: raw.owner.avatar_url,
  };
}

/** GitHub owner/repo names: alphanumerics, `-`, `_`, `.`. Validated before
 * they are interpolated into an API path. */
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

/** Upstream GitHub failure (rate limit, revoked token, outage), surfaced as a
 * 502 so the console can show "GitHub is unavailable" and not a generic 500. */
export class GitHubUpstreamError extends SandboxError {
  constructor(message: string) {
    super(message, "GITHUB_UPSTREAM", 502);
    this.name = "GitHubUpstreamError";
  }
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class GitHubRepoService {
  private readonly listCache = new Map<string, CacheEntry<GitHubRepoList>>();
  private readonly inspectCache = new Map<
    string,
    CacheEntry<GitHubRepoInspection>
  >();

  constructor(
    private readonly deps: {
      userService: Pick<UserService, "getById">;
      fetch?: Fetch;
      now?: () => number;
      /** Test seam; defaults to the server mode. */
      mode?: () => "mock" | "bypassed" | "real";
    },
  ) {}

  private get fetch(): Fetch {
    return this.deps.fetch ?? ((input, init) => fetch(input, init));
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private mode(): "mock" | "bypassed" | "real" {
    if (this.deps.mode) return this.deps.mode();
    if (isMock()) return "mock";
    return isAuthBypassed() ? "bypassed" : "real";
  }

  /** The caller's OWN token. Deliberately no cross-user fallback. */
  private tokenFor(userId: string): string | undefined {
    const mode = this.mode();
    if (mode === "bypassed") {
      return process.env.ATELIER_GITHUB_TOKEN?.trim() || undefined;
    }
    if (mode === "mock") return undefined;
    return this.deps.userService.getById(userId)?.githubAccessToken;
  }

  /** Repos the caller can access (owned, collaborator, org member), most
   * recently pushed first. Cached per user for a minute; `refresh` bypasses
   * the cache (the console's explicit refresh button). */
  async listRepos(
    userId: string,
    options: { refresh?: boolean } = {},
  ): Promise<GitHubRepoList> {
    if (this.mode() === "mock") return MOCK_LIST;
    const token = this.tokenFor(userId);
    if (!token) return { connected: false, repos: [], truncated: false };

    const cached = this.listCache.get(userId);
    if (!options.refresh && cached && cached.expiresAt > this.now()) {
      return cached.value;
    }

    const repos: GitHubRepo[] = [];
    let truncated = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await this.get<RawRepo[]>(
        token,
        `/user/repos?affiliation=owner,collaborator,organization_member` +
          `&sort=pushed&direction=desc&per_page=${PER_PAGE}&page=${page}`,
      );
      repos.push(...batch.map(toRepo));
      if (batch.length < PER_PAGE) break;
      if (page === MAX_PAGES) truncated = true;
    }
    const value: GitHubRepoList = { connected: true, repos, truncated };
    this.pruneExpired(this.listCache);
    this.listCache.set(userId, {
      value,
      expiresAt: this.now() + LIST_TTL_MS,
    });
    return value;
  }

  /** Branches + setup-step suggestions for one repo, used to prefill the
   * quick-create form. `ref` picks the branch whose root files are sniffed
   * (default: the repo's default branch). */
  async inspectRepo(
    userId: string,
    owner: string,
    name: string,
    ref?: string,
  ): Promise<GitHubRepoInspection> {
    if (!NAME_RE.test(owner) || !NAME_RE.test(name)) {
      throw new ValidationError("Invalid repository owner or name");
    }
    if (this.mode() === "mock") return mockInspection(owner, name, ref);
    const token = this.tokenFor(userId);
    if (!token) {
      throw new ValidationError(
        "No GitHub token for this user: sign in with GitHub again",
      );
    }

    // GitHub owner/repo names are case-insensitive; git branches are not.
    const cacheKey = `${userId}\0${owner.toLowerCase()}/${name.toLowerCase()}\0${ref ?? ""}`;
    const cached = this.inspectCache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const base = `/repos/${owner}/${name}`;
    const repo = toRepo(
      await this.get<RawRepo>(token, base, `${owner}/${name}`),
    );
    const at = ref?.trim() || repo.defaultBranch;
    const [branches, contents] = await Promise.all([
      this.get<{ name: string }[]>(
        token,
        `${base}/branches?per_page=${MAX_BRANCHES}`,
      ).catch((err) => {
        log.warn({ err, repo: repo.fullName }, "branch listing failed");
        return [] as { name: string }[];
      }),
      // An empty repo 404s its contents, and a missing ref 404s too. Both
      // just mean "nothing to suggest", not a failed inspection.
      this.get<{ name: string; type: string }[]>(
        token,
        `${base}/contents/?ref=${encodeURIComponent(at)}`,
      ).catch(() => [] as { name: string; type: string }[]),
    ]);
    const rootFiles = new Set(
      (Array.isArray(contents) ? contents : [])
        .filter((entry) => entry.type === "file")
        .map((entry) => entry.name),
    );
    const branchNames = branches.map((b) => b.name);
    const value: GitHubRepoInspection = {
      fullName: repo.fullName,
      cloneUrl: repo.cloneUrl,
      defaultBranch: repo.defaultBranch,
      branches: [
        repo.defaultBranch,
        ...branchNames.filter((b) => b !== repo.defaultBranch),
      ],
      suggestedBuild: detectSetupSteps((f) => rootFiles.has(f)),
    };
    this.pruneExpired(this.inspectCache);
    this.inspectCache.set(cacheKey, {
      value,
      expiresAt: this.now() + INSPECT_TTL_MS,
    });
    return value;
  }

  /** Drop expired entries once a cache grows past a bound, so a long-lived
   * server doesn't accumulate one entry per repo/branch ever inspected. */
  private pruneExpired<T>(cache: Map<string, CacheEntry<T>>): void {
    if (cache.size < MAX_CACHE_ENTRIES) return;
    const now = this.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
  }

  /** GET a GitHub API path. `resource` names the thing for a 404 message
   * (e.g. `owner/name`), never the raw API path. */
  private async get<T>(
    token: string,
    path: string,
    resource = "resource",
  ): Promise<T> {
    let response: Response;
    try {
      response = await githubApiGet(token, path, this.fetch);
    } catch (err) {
      log.warn({ err, path }, "GitHub request failed");
      throw new GitHubUpstreamError("Could not reach GitHub");
    }
    if (response.status === 404) {
      throw new NotFoundError("GitHub repository", resource);
    }
    if (!response.ok) {
      const rateLimited =
        response.status === 403 &&
        response.headers.get("x-ratelimit-remaining") === "0";
      log.warn({ status: response.status, path }, "GitHub API error");
      throw new GitHubUpstreamError(
        rateLimited
          ? "GitHub API rate limit reached; try again in a few minutes"
          : response.status === 401
            ? "GitHub rejected the stored token: sign in with GitHub again"
            : `GitHub API error (${response.status})`,
      );
    }
    return (await response.json()) as T;
  }
}

// ── mock fixture ────────────────────────────────────────────────────────────

function mockRepo(
  owner: string,
  name: string,
  opts: Partial<GitHubRepo> & { daysAgo: number },
): GitHubRepo {
  const { daysAgo, ...rest } = opts;
  return {
    fullName: `${owner}/${name}`,
    owner,
    name,
    cloneUrl: `https://github.com/${owner}/${name}.git`,
    htmlUrl: `https://github.com/${owner}/${name}`,
    description: null,
    private: false,
    fork: false,
    archived: false,
    defaultBranch: "main",
    language: "TypeScript",
    pushedAt: new Date(
      Date.UTC(2026, 8, 24) - daysAgo * 86_400_000,
    ).toISOString(),
    ownerAvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
    ...rest,
  };
}

const MOCK_LIST: GitHubRepoList = {
  connected: true,
  truncated: false,
  repos: [
    mockRepo("frak-id", "atelier", {
      daysAgo: 0,
      description: "Orchestrator for isolated dev environments",
    }),
    mockRepo("frak-id", "wallet", {
      daysAgo: 1,
      private: true,
      description: "Frak wallet app",
    }),
    mockRepo("frak-id", "backend", {
      daysAgo: 3,
      private: true,
      description: "Frak backend services",
    }),
    mockRepo("mock-user", "dotfiles", {
      daysAgo: 12,
      language: "Shell",
    }),
    mockRepo("frak-id", "contracts", {
      daysAgo: 30,
      language: "Solidity",
      description: "Smart contracts",
    }),
    mockRepo("mock-user", "rust-playground", {
      daysAgo: 45,
      language: "Rust",
      defaultBranch: "master",
    }),
    mockRepo("mock-user", "legacy-site", {
      daysAgo: 400,
      language: "PHP",
      archived: true,
    }),
    mockRepo("mock-user", "react", {
      daysAgo: 90,
      language: "JavaScript",
      fork: true,
      description: "Fork of facebook/react",
    }),
  ],
};

const MOCK_ROOT_FILES: Record<string, string[]> = {
  TypeScript: ["package.json", "bun.lock"],
  JavaScript: ["package.json", "yarn.lock"],
  Rust: ["Cargo.toml"],
  PHP: ["composer.json"],
  Solidity: ["package.json", "pnpm-lock.yaml"],
};

function mockInspection(
  owner: string,
  name: string,
  _ref?: string,
): GitHubRepoInspection {
  const repo = MOCK_LIST.repos.find(
    (r) => r.fullName.toLowerCase() === `${owner}/${name}`.toLowerCase(),
  );
  if (!repo) throw new NotFoundError("GitHub repository", `${owner}/${name}`);
  const files = new Set(MOCK_ROOT_FILES[repo.language ?? ""] ?? []);
  return {
    fullName: repo.fullName,
    cloneUrl: repo.cloneUrl,
    defaultBranch: repo.defaultBranch,
    branches: [repo.defaultBranch, "dev", "feat/quick-prebuild"],
    suggestedBuild: detectSetupSteps((f) => files.has(f)),
  };
}
