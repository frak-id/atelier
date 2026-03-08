import { jwt } from "@elysiajs/jwt";
import { Elysia, t } from "elysia";
import { nanoid } from "nanoid";
import { sandboxService } from "../container.ts";
import { isUserAuthorized } from "../modules/auth/auth.service.ts";
import { verifyJwt } from "../shared/lib/auth.ts";
import {
  config,
  dashboardUrl,
  deriveCallbackUrl,
  isMock,
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
  .get("/github", async ({ redirect, cookie, jwt }) => {
    if (isMock()) {
      const token = await jwt.sign({
        sub: "12345",
        username: "mock-user",
        avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
        email: "12345+mock-user@users.noreply.github.com",
      });

      cookie.sandbox_token?.set({
        value: token,
        httpOnly: true,
        secure: false,
        sameSite: "none",
        path: "/",
        maxAge: JWT_EXPIRY_SECONDS,
      });

      log.info("Mock: user auto-logged in as mock-user");
      return redirect("/");
    }

    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    cookie.oauth_code_verifier?.set({
      value: codeVerifier,
      httpOnly: true,
      secure: isProduction(),
      sameSite: isProduction() ? "none" : "lax",
      path: "/",
      domain: `.${config.domain.baseDomain}`,
      maxAge: 600,
    });

    const url = buildOAuthRedirectUrl(
      deriveCallbackUrl("/auth/callback"),
      "read:user read:org",
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
    async ({ query, redirect, jwt, cookie }) => {
      if (query.error) {
        log.error({ error: query.error }, "GitHub OAuth error");
        return redirect(`${dashboardUrl}?login_error=${query.error}`);
      }

      if (!query.code) {
        return redirect(`${dashboardUrl}?login_error=no_code`);
      }

      try {
        const codeVerifier = cookie.oauth_code_verifier?.value as
          | string
          | undefined;
        cookie.oauth_code_verifier?.set({
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

        const isAuthorized = await isUserAuthorized(accessToken, user.login);
        if (!isAuthorized) {
          log.warn(
            { username: user.login },
            "Unauthorized user attempted login",
          );
          return redirect(`${dashboardUrl}?login_error=unauthorized`);
        }

        const token = await jwt.sign({
          sub: String(user.id),
          username: user.login,
          avatarUrl: user.avatar_url,
          email: `${user.id}+${user.login}@users.noreply.github.com`,
        });

        cookie.sandbox_token?.set({
          value: token,
          httpOnly: true,
          secure: isProduction(),
          sameSite: isProduction() ? "none" : "lax",
          path: "/",
          domain: `.${config.domain.baseDomain}`,
          maxAge: JWT_EXPIRY_SECONDS,
        });

        log.info({ username: user.login }, "User logged in successfully");

        return redirect(dashboardUrl);
      } catch (error) {
        log.error({ error }, "GitHub login callback failed");
        return redirect(`${dashboardUrl}?login_error=callback_failed`);
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
  .get("/me", async ({ cookie, set }) => {
    const token = cookie.sandbox_token?.value as string | undefined;
    if (!token) {
      set.status = 401;
      return { error: "UNAUTHORIZED", message: "Missing authentication" };
    }

    const user = await verifyJwt(token);
    if (!user) {
      set.status = 401;
      return { error: "UNAUTHORIZED", message: "Invalid or expired token" };
    }

    return {
      id: user.id,
      username: user.username,
      avatarUrl: user.avatarUrl,
      email: user.email,
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
  .get("/opencode/verify", async ({ cookie, set, headers }) => {
    if (headers.authorization) {
      set.headers.authorization = headers.authorization;
      return { ok: true };
    }

    if (isMock()) {
      const mockAuth = Buffer.from("opencode:mock-password").toString("base64");
      set.headers.authorization = `Basic ${mockAuth}`;
      return { ok: true };
    }

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

    const forwardedHost = headers["x-forwarded-host"];
    if (!forwardedHost) {
      set.status = 400;
      return { error: "BAD_REQUEST", message: "Missing X-Forwarded-Host" };
    }

    const match = forwardedHost.match(/^opencode-([^.]+)\./);
    if (!match?.[1]) {
      set.status = 400;
      return {
        error: "BAD_REQUEST",
        message: "Cannot extract sandbox ID from host",
      };
    }

    const sandboxId = match[1];
    const sandbox = sandboxService.getById(sandboxId);
    if (!sandbox) {
      set.status = 404;
      return {
        error: "NOT_FOUND",
        message: "Sandbox not found",
      };
    }

    // Inject Basic Auth header for Ingress to forward to OpenCode.
    // Traefik's authResponseHeaders copies this to the upstream request.
    if (sandbox.runtime.opencodePassword) {
      const basicAuth = Buffer.from(
        `opencode:${sandbox.runtime.opencodePassword}`,
      ).toString("base64");
      set.headers.authorization = `Basic ${basicAuth}`;
    }

    return { ok: true, user: user.username };
  })
  .post("/logout", ({ cookie }) => {
    cookie.sandbox_token?.set({
      value: "",
      httpOnly: true,
      secure: isProduction(),
      sameSite: isProduction() ? "none" : "lax",
      path: "/",
      domain: `.${config.domain.baseDomain}`,
      maxAge: 0,
    });
    return { ok: true };
  });
