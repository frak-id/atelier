import { Elysia, t } from "elysia";
import { nanoid } from "nanoid";
import { gitSourceService } from "../container.ts";
import {
  GitHubBranchesQuerySchema,
  GitHubBranchesResponseSchema,
  GitHubReposQuerySchema,
  GitHubReposResponseSchema,
  type GitHubSourceConfig,
  type GitHubStatusResponse,
  type GitSource,
  type GitSourceConfig,
} from "../schemas/index.ts";
import {
  config,
  dashboardUrl,
  deriveCallbackUrl,
  isProduction,
} from "../shared/lib/config.ts";
import {
  buildOAuthRedirectUrl,
  exchangeCodeForToken,
  fetchGitHubUser,
  generateCodeChallenge,
  generateCodeVerifier,
} from "../shared/lib/github.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("github-api");

const GITHUB_SOURCE_TYPE = "github";

function getGitHubSource(): GitSource | undefined {
  const sources = gitSourceService.getAll();
  return sources.find((s) => s.type === GITHUB_SOURCE_TYPE);
}

function getGitHubAccessToken(): string | null {
  const source = getGitHubSource();
  if (!source) return null;

  const ghConfig = source.config as GitHubSourceConfig;
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
  )
  .get("/status", (): GitHubStatusResponse => {
    const source = getGitHubSource();

    if (!source) {
      return { connected: false };
    }

    const ghConfig = source.config as GitHubSourceConfig;
    return {
      connected: true,
      user: {
        login: ghConfig.username,
        avatarUrl: ghConfig.avatarUrl,
      },
    };
  })
  .post("/disconnect", () => {
    const source = getGitHubSource();

    if (source) {
      gitSourceService.delete(source.id);
      log.info("GitHub disconnected");
    }

    return {
      success: true,
      message:
        "Disconnected. To revoke access on GitHub: https://github.com/settings/applications",
    };
  });

/**
 * GitHub OAuth browser-redirect routes.
 * These are NOT behind the auth guard because they involve browser redirects
 * (window.location.href) where the JWT cannot be sent as a header.
 */
export const githubOAuthRoutes = new Elysia({ prefix: "/github" })
  .get("/connect", async ({ redirect, cookie }) => {
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    cookie.github_code_verifier?.set({
      value: codeVerifier,
      httpOnly: true,
      secure: isProduction(),
      sameSite: isProduction() ? "none" : "lax",
      path: "/",
      domain: `.${config.domain.baseDomain}`,
      maxAge: 600,
    });

    const url = buildOAuthRedirectUrl(
      deriveCallbackUrl("/api/github/callback"),
      "repo read:user read:org",
      {
        state: nanoid(16),
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      },
    );
    return redirect(url);
  })
  .get(
    "/callback",
    async ({ query, redirect, cookie }) => {
      if (query.error) {
        log.error({ error: query.error }, "GitHub OAuth error");
        return redirect(`${dashboardUrl}?github_error=${query.error}`);
      }

      if (!query.code) {
        return redirect(`${dashboardUrl}?github_error=no_code`);
      }

      try {
        const codeVerifier = cookie.github_code_verifier?.value as
          | string
          | undefined;
        cookie.github_code_verifier?.set({
          value: "",
          httpOnly: true,
          secure: isProduction(),
          sameSite: isProduction() ? "none" : "lax",
          path: "/",
          domain: `.${config.domain.baseDomain}`,
          maxAge: 0,
        });

        const accessToken = await exchangeCodeForToken(
          query.code,
          codeVerifier,
        );
        const user = await fetchGitHubUser(accessToken);

        const existingSource = getGitHubSource();

        const sourceConfig: GitHubSourceConfig = {
          accessToken,
          userId: String(user.id),
          username: user.login,
          avatarUrl: user.avatar_url,
        };

        if (existingSource) {
          gitSourceService.update(existingSource.id, {
            config: sourceConfig as unknown as GitSourceConfig,
          });
          log.info(
            { userId: user.id, login: user.login },
            "GitHub reconnected",
          );
        } else {
          gitSourceService.create(
            GITHUB_SOURCE_TYPE,
            `GitHub (${user.login})`,
            sourceConfig as unknown as GitSourceConfig,
          );
          log.info({ userId: user.id, login: user.login }, "GitHub connected");
        }

        return redirect(`${dashboardUrl}?github_success=true`);
      } catch (error) {
        log.error({ error }, "GitHub OAuth callback failed");
        return redirect(`${dashboardUrl}?github_error=callback_failed`);
      }
    },
    {
      query: t.Object({
        code: t.Optional(t.String()),
        state: t.Optional(t.String()),
        error: t.Optional(t.String()),
      }),
    },
  )
  .post("/reauthorize", async ({ redirect, cookie }) => {
    const source = getGitHubSource();

    if (source) {
      gitSourceService.delete(source.id);
      log.info("GitHub connection deleted for reauthorization");
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    cookie.github_code_verifier?.set({
      value: codeVerifier,
      httpOnly: true,
      secure: isProduction(),
      sameSite: isProduction() ? "none" : "lax",
      path: "/",
      domain: `.${config.domain.baseDomain}`,
      maxAge: 600,
    });

    const url = buildOAuthRedirectUrl(
      deriveCallbackUrl("/api/github/callback"),
      "repo read:user read:org",
      {
        state: nanoid(16),
        prompt: "consent",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      },
    );
    return redirect(url);
  });
