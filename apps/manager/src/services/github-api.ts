import { createChildLogger } from "../lib/logger.ts";

const log = createChildLogger("github-api");

const GITHUB_API_BASE = "https://api.github.com";

export interface GitHubRepository {
  id: number;
  name: string;
  full_name: string;
  owner: {
    login: string;
    avatar_url: string;
  };
  private: boolean;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  updated_at: string;
  pushed_at: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  fork: boolean;
}

export interface ListReposOptions {
  affiliation?: "owner" | "collaborator" | "organization_member";
  sort?: "created" | "updated" | "pushed" | "full_name";
  direction?: "asc" | "desc";
  perPage?: number;
  page?: number;
}

export interface GitHubReposResult {
  repositories: GitHubRepository[];
  pagination: {
    page: number;
    perPage: number;
    hasMore: boolean;
  };
}

function getGitHubHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export const GitHubApiService = {
  async listRepositories(
    accessToken: string,
    options: ListReposOptions = {},
  ): Promise<GitHubReposResult> {
    const {
      affiliation = "owner,collaborator,organization_member",
      sort = "updated",
      direction = "desc",
      perPage = 30,
      page = 1,
    } = options;

    const params = new URLSearchParams({
      affiliation,
      sort,
      direction,
      per_page: String(perPage),
      page: String(page),
    });

    const url = `${GITHUB_API_BASE}/user/repos?${params.toString()}`;
    log.debug({ url, page, perPage }, "Fetching GitHub repositories");

    const response = await fetch(url, {
      headers: getGitHubHeaders(accessToken),
    });

    if (!response.ok) {
      const text = await response.text();
      log.error(
        { status: response.status, body: text },
        "Failed to fetch repositories",
      );

      if (response.status === 401) {
        throw new Error("GitHub token is invalid or expired");
      }

      throw new Error(`GitHub API error: ${response.status}`);
    }

    const repos = (await response.json()) as GitHubRepository[];

    const linkHeader = response.headers.get("Link");
    const hasMore = linkHeader?.includes('rel="next"') ?? false;

    log.debug(
      { count: repos.length, page, hasMore },
      "Fetched GitHub repositories",
    );

    return {
      repositories: repos,
      pagination: {
        page,
        perPage,
        hasMore,
      },
    };
  },

  async getRepository(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<GitHubRepository> {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}`;
    log.debug({ owner, repo }, "Fetching GitHub repository");

    const response = await fetch(url, {
      headers: getGitHubHeaders(accessToken),
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Repository ${owner}/${repo} not found`);
      }
      throw new Error(`GitHub API error: ${response.status}`);
    }

    return response.json() as Promise<GitHubRepository>;
  },

  async searchRepositories(
    accessToken: string,
    query: string,
    options: { perPage?: number; page?: number } = {},
  ): Promise<GitHubReposResult> {
    const { perPage = 30, page = 1 } = options;

    const params = new URLSearchParams({
      q: `${query} user:@me`,
      sort: "updated",
      order: "desc",
      per_page: String(perPage),
      page: String(page),
    });

    const url = `${GITHUB_API_BASE}/search/repositories?${params.toString()}`;
    log.debug({ query, page, perPage }, "Searching GitHub repositories");

    const response = await fetch(url, {
      headers: getGitHubHeaders(accessToken),
    });

    if (!response.ok) {
      throw new Error(`GitHub search API error: ${response.status}`);
    }

    const data = (await response.json()) as {
      items: GitHubRepository[];
      total_count: number;
    };

    const hasMore = data.total_count > page * perPage;

    return {
      repositories: data.items,
      pagination: {
        page,
        perPage,
        hasMore,
      },
    };
  },
};
