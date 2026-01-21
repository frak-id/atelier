import { jwt } from "@elysiajs/jwt";
import { Elysia, t } from "elysia";
import { nanoid } from "nanoid";
import { config } from "../../shared/lib/config.ts";
import { createChildLogger } from "../../shared/lib/logger.ts";
import { isUserAuthorized } from "./auth.service.ts";

const log = createChildLogger("auth-routes");

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

const JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

interface GitHubUser {
  id: number;
  login: string;
  avatar_url: string;
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

export const authRoutes = new Elysia({ prefix: "/login" })
  .use(
    jwt({
      name: "jwt",
      secret: config.auth.jwtSecret,
      exp: `${JWT_EXPIRY_SECONDS}s`,
    }),
  )
  .get("/github", ({ redirect }) => {
    if (!config.github.clientId) {
      throw new Error("GitHub OAuth not configured");
    }

    const params = new URLSearchParams({
      client_id: config.github.clientId,
      redirect_uri: config.github.loginCallbackUrl,
      scope: "read:user read:org",
      state: nanoid(16),
    });

    return redirect(`${GITHUB_AUTHORIZE_URL}?${params.toString()}`);
  })
  .get(
    "/callback",
    async ({ query, redirect, jwt }) => {
      if (query.error) {
        log.error({ error: query.error }, "GitHub OAuth error");
        return redirect(`${config.dashboardUrl}?login_error=${query.error}`);
      }

      if (!query.code) {
        return redirect(`${config.dashboardUrl}?login_error=no_code`);
      }

      try {
        const accessToken = await exchangeCodeForToken(query.code);
        const user = await fetchGitHubUser(accessToken);

        const isAuthorized = await isUserAuthorized(accessToken, user.login);
        if (!isAuthorized) {
          log.warn(
            { username: user.login },
            "Unauthorized user attempted login",
          );
          return redirect(`${config.dashboardUrl}?login_error=unauthorized`);
        }

        const token = await jwt.sign({
          sub: String(user.id),
          username: user.login,
          avatarUrl: user.avatar_url,
        });

        log.info({ username: user.login }, "User logged in successfully");

        return redirect(`${config.dashboardUrl}?login_token=${token}`);
      } catch (error) {
        log.error({ error }, "GitHub login callback failed");
        return redirect(`${config.dashboardUrl}?login_error=callback_failed`);
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
  .get("/me", async ({ headers, jwt, set }) => {
    const authHeader = headers.authorization;
    if (!authHeader) {
      set.status = 401;
      return { error: "UNAUTHORIZED", message: "Missing authorization header" };
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) {
      set.status = 401;
      return { error: "UNAUTHORIZED", message: "Invalid authorization format" };
    }

    const payload = await jwt.verify(match[1]);
    if (!payload) {
      set.status = 401;
      return { error: "UNAUTHORIZED", message: "Invalid or expired token" };
    }

    return {
      id: payload.sub,
      username: payload.username,
      avatarUrl: payload.avatarUrl,
    };
  });
