import { jwt } from "@elysiajs/jwt";
import { Elysia, t } from "elysia";
import { nanoid } from "nanoid";
import { isUserAuthorized } from "../modules/auth/auth.service.ts";
import { verifyJwt } from "../shared/lib/auth.ts";
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
    async ({ query, redirect, jwt, cookie }) => {
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

        cookie.sandbox_token?.set({
          value: token,
          httpOnly: true,
          secure: config.isProduction(),
          sameSite: config.isProduction() ? "none" : "lax",
          path: "/",
          domain: `.${config.caddy.domainSuffix}`,
          maxAge: JWT_EXPIRY_SECONDS,
        });

        log.info({ username: user.login }, "User logged in successfully");

        return redirect(config.dashboardUrl);
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
  .get("/me", async ({ cookie, jwt, set }) => {
    const token = cookie.sandbox_token?.value as string | undefined;
    if (!token) {
      set.status = 401;
      return { error: "UNAUTHORIZED", message: "Missing authentication" };
    }

    const payload = await jwt.verify(token);
    if (!payload) {
      set.status = 401;
      return { error: "UNAUTHORIZED", message: "Invalid or expired token" };
    }

    return {
      id: payload.sub,
      username: payload.username,
      avatarUrl: payload.avatarUrl,
    };
  })
  .get("/verify", async ({ cookie, set }) => {
    const token = cookie.sandbox_token?.value as string | undefined;
    if (!token) {
      set.status = 401;
      return { error: "UNAUTHORIZED", message: "No token provided" };
    }

    const user = await verifyJwt(token);
    if (!user) {
      set.status = 401;
      return { error: "UNAUTHORIZED", message: "Invalid or expired token" };
    }

    return { ok: true, user: user.username };
  })
  .post("/logout", ({ cookie }) => {
    cookie.sandbox_token?.set({
      value: "",
      httpOnly: true,
      secure: config.isProduction(),
      sameSite: config.isProduction() ? "none" : "lax",
      path: "/",
      domain: `.${config.caddy.domainSuffix}`,
      maxAge: 0,
    });
    return { ok: true };
  });
