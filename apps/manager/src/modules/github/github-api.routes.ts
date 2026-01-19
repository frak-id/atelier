import { Elysia } from "elysia";
import { gitSourceService } from "../../container.ts";
import {
  GitHubReposQuerySchema,
  GitHubReposResponseSchema,
  type GitHubSourceConfig,
} from "../../schemas/index.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";

const log = createChildLogger("github-api");

const GITHUB_SOURCE_TYPE = "github";

function getGitHubAccessToken(): string | null {
  const sources = gitSourceService.getAll();
  const githubSource = sources.find((s) => s.type === GITHUB_SOURCE_TYPE);

  if (!githubSource) return null;

  const ghConfig = githubSource.config as GitHubSourceConfig;
  return ghConfig.accessToken;
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string; avatar_url: string };
  private: boolean;
  html_url: string;
  clone_url: string;
  ssh_url: string;
  default_branch: string;
  updated_at: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  fork: boolean;
}

export const githubApiRoutes = new Elysia({ prefix: "/github" }).get(
  "/repos",
  async ({ query }) => {
    const accessToken = getGitHubAccessToken();

    if (!accessToken) {
      return {
        repositories: [],
        pagination: { page: 1, perPage: 30, hasMore: false },
      };
    }

    const page = query.page ? Number.parseInt(query.page, 10) : 1;
    const perPage = query.perPage ? Number.parseInt(query.perPage, 10) : 30;
    const affiliation =
      query.affiliation || "owner,collaborator,organization_member";
    const sort = query.sort || "updated";

    const params = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
      affiliation,
      sort,
    });

    const response = await fetch(
      `https://api.github.com/user/repos?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );

    if (!response.ok) {
      log.error({ status: response.status }, "GitHub API error");
      return {
        repositories: [],
        pagination: { page, perPage, hasMore: false },
      };
    }

    const repos = (await response.json()) as GitHubRepo[];
    const linkHeader = response.headers.get("Link");
    const hasMore = linkHeader?.includes('rel="next"') ?? false;

    return {
      repositories: repos.map((repo) => ({
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        owner: {
          login: repo.owner.login,
          avatarUrl: repo.owner.avatar_url,
        },
        private: repo.private,
        htmlUrl: repo.html_url,
        cloneUrl: repo.clone_url,
        sshUrl: repo.ssh_url,
        defaultBranch: repo.default_branch,
        updatedAt: repo.updated_at,
        description: repo.description,
        language: repo.language,
        stargazersCount: repo.stargazers_count,
        fork: repo.fork,
      })),
      pagination: { page, perPage, hasMore },
    };
  },
  {
    query: GitHubReposQuerySchema,
    response: GitHubReposResponseSchema,
    detail: { tags: ["github"] },
  },
);
