import { Elysia, t } from "elysia";
import { nanoid } from "nanoid";
import { gitSourceService } from "../container.ts";
import type {
  GitHubSourceConfig,
  GitHubStatusResponse,
  GitSource,
  GitSourceConfig,
} from "../schemas/index.ts";
import { config } from "../shared/lib/config.ts";
import {
  buildOAuthRedirectUrl,
  exchangeCodeForToken,
  fetchGitHubUser,
} from "../shared/lib/github.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("github-auth");

const GITHUB_SOURCE_TYPE = "github";

function getGitHubSource(): GitSource | undefined {
  const sources = gitSourceService.getAll();
  return sources.find((s) => s.type === GITHUB_SOURCE_TYPE);
}

export const githubAuthRoutes = new Elysia({ prefix: "/github" })
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
  .get("/login", ({ redirect }) => {
    const url = buildOAuthRedirectUrl(
      config.github.callbackUrl,
      "repo read:user read:org",
      { state: nanoid(16) },
    );
    return redirect(url);
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
      gitSourceService.delete(source.id);
      log.info("GitHub disconnected");
    }

    return {
      success: true,
      message:
        "Disconnected. To revoke access on GitHub: https://github.com/settings/applications",
    };
  })
  .post("/reauthorize", ({ redirect }) => {
    const source = getGitHubSource();

    if (source) {
      gitSourceService.delete(source.id);
      log.info("GitHub connection deleted for reauthorization");
    }

    const url = buildOAuthRedirectUrl(
      config.github.callbackUrl,
      "repo read:user read:org",
      { state: nanoid(16), prompt: "consent" },
    );
    return redirect(url);
  });
