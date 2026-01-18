import { Elysia } from "elysia";
import { UnauthorizedError } from "../../lib/errors.ts";
import { createChildLogger } from "../../lib/logger.ts";
import { GitHubApiService } from "../../services/github-api.ts";
import { GitHubAuthService } from "../../services/github-auth.ts";
import { GitHubModel } from "./model.ts";

const log = createChildLogger("github-route");

function transformRepository(repo: {
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
}) {
  return {
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
  };
}

export const githubRoutes = new Elysia({ prefix: "/github" }).get(
  "/repos",
  async ({ query }) => {
    const token = await GitHubAuthService.getDecryptedToken();

    if (!token) {
      throw new UnauthorizedError("GitHub not connected");
    }

    const { page, perPage, affiliation, sort } = query;

    log.debug({ page, perPage, affiliation }, "Fetching GitHub repositories");

    const result = await GitHubApiService.listRepositories(token, {
      page: page ?? 1,
      perPage: perPage ?? 30,
      affiliation,
      sort: sort ?? "updated",
    });

    return {
      repositories: result.repositories.map(transformRepository),
      pagination: result.pagination,
    };
  },
  {
    query: GitHubModel.reposQuery,
    response: GitHubModel.reposResponse,
  },
);
