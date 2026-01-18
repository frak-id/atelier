import { Elysia, t } from "elysia";
import { nanoid } from "nanoid";
import { config } from "../../lib/config.ts";
import { createChildLogger } from "../../lib/logger.ts";
import { GitSourceRepository } from "../../state/database.ts";
import type { GitHubSourceConfig, GitSource } from "../../types/index.ts";

const log = createChildLogger("github-auth");

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

const GITHUB_SOURCE_TYPE = "github";

function getGitHubSource(): GitSource | undefined {
  const sources = GitSourceRepository.getAll();
  return sources.find((s) => s.type === GITHUB_SOURCE_TYPE);
}

async function exchangeCodeForToken(code: string): Promise<string> {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: config.github.clientId,
      client_secret: config.github.clientSecret,
      code,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    error?: string;
  };
  if (data.error || !data.access_token) {
    throw new Error(data.error || "No access token received");
  }

  return data.access_token;
}

interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
}

async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const response = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub user fetch failed: ${response.status}`);
  }

  return response.json() as Promise<GitHubUser>;
}

export const githubAuthRoutes = new Elysia({ prefix: "/github" })
  .get("/status", () => {
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
  .get("/login", ({ redirect }) => {
    if (!config.github.clientId) {
      throw new Error("GitHub OAuth not configured");
    }

    const params = new URLSearchParams({
      client_id: config.github.clientId,
      redirect_uri: config.github.callbackUrl,
      scope: "repo read:user",
      state: nanoid(16),
    });

    return redirect(`${GITHUB_AUTHORIZE_URL}?${params.toString()}`);
  })
  .get(
    "/callback",
    async ({ query, redirect }) => {
      if (query.error) {
        log.error({ error: query.error }, "GitHub OAuth error");
        return redirect(`${config.dashboardUrl}?github_error=${query.error}`);
      }

      if (!query.code) {
        return redirect(`${config.dashboardUrl}?github_error=no_code`);
      }

      try {
        const accessToken = await exchangeCodeForToken(query.code);
        const user = await fetchGitHubUser(accessToken);

        const existingSource = getGitHubSource();
        const now = new Date().toISOString();

        const sourceConfig: GitHubSourceConfig = {
          accessToken,
          userId: String(user.id),
          username: user.login,
          avatarUrl: user.avatar_url,
        };

        if (existingSource) {
          GitSourceRepository.update(existingSource.id, {
            config: sourceConfig,
          });
          log.info(
            { userId: user.id, login: user.login },
            "GitHub reconnected",
          );
        } else {
          const newSource: GitSource = {
            id: nanoid(12),
            type: GITHUB_SOURCE_TYPE,
            name: `GitHub (${user.login})`,
            config: sourceConfig,
            createdAt: now,
            updatedAt: now,
          };
          GitSourceRepository.create(newSource);
          log.info({ userId: user.id, login: user.login }, "GitHub connected");
        }

        return redirect(`${config.dashboardUrl}?github_success=true`);
      } catch (error) {
        log.error({ error }, "GitHub OAuth callback failed");
        return redirect(`${config.dashboardUrl}?github_error=callback_failed`);
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
  .post("/logout", () => {
    const source = getGitHubSource();

    if (source) {
      GitSourceRepository.delete(source.id);
      log.info("GitHub disconnected");
    }

    return { success: true };
  });
