import { jwt } from "@elysiajs/jwt";
import { Elysia, t } from "elysia";
import { nanoid } from "nanoid";
import { isUserAuthorized } from "../modules/auth/auth.service.ts";
import { config } from "../shared/lib/config.ts";
import {
  buildOAuthRedirectUrl,
  exchangeCodeForToken,
  fetchGitHubUser,
} from "../shared/lib/github.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("auth-routes");

const JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

export const authRoutes = new Elysia({ prefix: "/auth" })
  .use(
    jwt({
      name: "jwt",
      secret: config.auth.jwtSecret,
      exp: `${JWT_EXPIRY_SECONDS}s`,
    }),
  )
  .get("/github", ({ redirect }) => {
    const url = buildOAuthRedirectUrl(
      config.github.loginCallbackUrl,
      "read:user read:org",
      { state: nanoid(16) },
    );
    return redirect(url);
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
