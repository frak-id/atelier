import { Elysia } from "elysia";
import { gitSourceService } from "../../container.ts";
import {
  GitHubBranchesQuerySchema,
  GitHubBranchesResponseSchema,
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

interface GitHubApiBranch {
  name: string;
  commit: {
    sha: string;
    url: string;
  };
  protected: boolean;
}

interface GitHubApiCommit {
  sha: string;
  commit: {
    committer: {
      date: string;
    } | null;
  };
}

export const githubApiRoutes = new Elysia({ prefix: "/github" })
  .get(
    "/branches",
    async ({ query }) => {
      const accessToken = getGitHubAccessToken();

      if (!accessToken) {
        return {
          branches: [],
          defaultBranch: "main",
        };
      }

      const { owner, repo } = query;

      const repoResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );

      if (!repoResponse.ok) {
        log.error(
          { status: repoResponse.status, owner, repo },
          "GitHub API error fetching repo",
        );
        return {
          branches: [],
          defaultBranch: "main",
        };
      }

      const repoData = (await repoResponse.json()) as GitHubRepo;
      const defaultBranch = repoData.default_branch;

      const branchesResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );

      if (!branchesResponse.ok) {
        log.error(
          { status: branchesResponse.status, owner, repo },
          "GitHub API error fetching branches",
        );
        return {
          branches: [
            { name: defaultBranch, isDefault: true, lastCommitDate: null },
          ],
          defaultBranch,
        };
      }

      const branchesData = (await branchesResponse.json()) as GitHubApiBranch[];

      const branchesWithDates = await Promise.all(
        branchesData.slice(0, 30).map(async (branch) => {
          try {
            const commitResponse = await fetch(branch.commit.url, {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
              },
            });

            if (commitResponse.ok) {
              const commitData =
                (await commitResponse.json()) as GitHubApiCommit;
              return {
                name: branch.name,
                isDefault: branch.name === defaultBranch,
                lastCommitDate: commitData.commit.committer?.date ?? null,
              };
            }
          } catch (error) {
            log.debug(
              { branch: branch.name, error },
              "Failed to fetch commit date",
            );
          }

          return {
            name: branch.name,
            isDefault: branch.name === defaultBranch,
            lastCommitDate: null,
          };
        }),
      );

      const remainingBranches = branchesData.slice(30).map((branch) => ({
        name: branch.name,
        isDefault: branch.name === defaultBranch,
        lastCommitDate: null,
      }));

      const allBranches = [...branchesWithDates, ...remainingBranches];

      allBranches.sort((a, b) => {
        if (a.isDefault && !b.isDefault) return -1;
        if (!a.isDefault && b.isDefault) return 1;

        if (a.lastCommitDate && b.lastCommitDate) {
          return (
            new Date(b.lastCommitDate).getTime() -
            new Date(a.lastCommitDate).getTime()
          );
        }
        if (a.lastCommitDate && !b.lastCommitDate) return -1;
        if (!a.lastCommitDate && b.lastCommitDate) return 1;

        return a.name.localeCompare(b.name);
      });

      return {
        branches: allBranches,
        defaultBranch,
      };
    },
    {
      query: GitHubBranchesQuerySchema,
      response: GitHubBranchesResponseSchema,
      detail: { tags: ["github"] },
    },
  )
  .get(
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
