/**
 * `/auth/*` — the GitHub OAuth login surface. Unauthenticated by definition
 * (it's how a caller *gets* a token): mints the `sandbox_token` JWT the rest
 * of `/v1`, `/api`, `/sessions` require (atelier-v2 PHASE0.md item 1).
 *
 * Ported from v1 `apps/manager/src/api/auth.routes.ts`, ACP/dashboard-scoped:
 * dropped the cliproxy user-key bootstrap and `/opencode/verify` forward-auth
 * route (out of v2 scope — forward-auth for tool ingresses is a separate,
 * still-open follow-up, not this login flow).
 */
import { Elysia, t } from "elysia";
import { nanoid } from "nanoid";
import {
  buildOAuthRedirectUrl,
  exchangeCodeForToken,
  fetchGitHubUser,
  generateCodeChallenge,
  generateCodeVerifier,
  isUserAuthorized,
  signJwt,
  verifyJwt,
} from "../control/index.ts";
import {
  config,
  dashboardUrl,
  deriveCallbackUrl,
  isMock,
  isProduction,
} from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { ServerContainer } from "./container.ts";

const log = createChildLogger("auth-routes");

const JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

const MOCK_USER = {
  githubId: "12345",
  username: "mock-user",
  email: "12345+mock-user@users.noreply.github.com",
  avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4",
  accessToken: "mock-github-token",
};

export function createAuthRoutes(container: ServerContainer) {
  const { userService, organizationService, orgMemberService } =
    container.control;

  /** Bootstrap a personal org + owner membership on a user's first login. */
  function ensurePersonalOrg(userId: string, login: string): void {
    const user = userService.getById(userId);
    if (user?.personalOrgId) return;
    const personalOrg = organizationService.create(
      login,
      login.toLowerCase(),
      true,
    );
    userService.setPersonalOrg(userId, personalOrg.id);
    orgMemberService.addMember(personalOrg.id, userId, "owner");
  }

  return new Elysia({ prefix: "/auth" })
    .get("/github", async ({ redirect, cookie }) => {
      if (isMock()) {
        const token = await signJwt({
          id: MOCK_USER.githubId,
          username: MOCK_USER.username,
          avatarUrl: MOCK_USER.avatarUrl,
          email: MOCK_USER.email,
        });

        cookie.sandbox_token?.set({
          value: token,
          httpOnly: true,
          secure: false,
          sameSite: "none",
          path: "/",
          maxAge: JWT_EXPIRY_SECONDS,
        });

        userService.upsertFromLogin(
          MOCK_USER.githubId,
          MOCK_USER.username,
          MOCK_USER.email,
          MOCK_USER.avatarUrl,
          MOCK_USER.accessToken,
        );
        ensurePersonalOrg(MOCK_USER.githubId, MOCK_USER.username);

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
          const ghUser = await fetchGitHubUser(accessToken);

          const authorized = await isUserAuthorized(accessToken, ghUser.login);
          if (!authorized) {
            log.warn(
              { username: ghUser.login },
              "Unauthorized user attempted login",
            );
            return redirect(`${dashboardUrl}?login_error=unauthorized`);
          }

          const email = `${ghUser.id}+${ghUser.login}@users.noreply.github.com`;
          userService.upsertFromLogin(
            String(ghUser.id),
            ghUser.login,
            email,
            ghUser.avatar_url,
            accessToken,
          );
          ensurePersonalOrg(String(ghUser.id), ghUser.login);

          const token = await signJwt({
            id: String(ghUser.id),
            username: ghUser.login,
            avatarUrl: ghUser.avatar_url,
            email,
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

          log.info({ username: ghUser.login }, "User logged in successfully");
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
    })
    .post("/api-token", async ({ cookie, set }) => {
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
      const apiToken = await signJwt(user);
      log.info({ username: user.username }, "API token generated");
      return { token: apiToken };
    });
}
