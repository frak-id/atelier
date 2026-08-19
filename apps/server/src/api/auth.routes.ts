/**
 * `/auth/*` — the GitHub OAuth login surface. Unauthenticated by definition
 * (it's how a caller *gets* a token): mints the `sandbox_token` JWT the rest
 * of `/v1`, `/api`, `/sessions` require (atelier-v2 PHASE0.md item 1).
 *
 * ACP/console-scoped: no cliproxy user-key bootstrap and no `/opencode/verify`
 * forward-auth route (forward-auth for tool ingresses is a separate,
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
  isAuthBypassed,
  isProduction,
} from "../shared/lib/config.ts";
import { createChildLogger } from "../shared/lib/logger.ts";
import type { ServerContainer } from "./container.ts";

const log = createChildLogger("auth-routes");

const JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

/** Scopes requested from GitHub at login. The resulting token is handed to
 * sandboxes as the git credential, so it bounds what the agent can push:
 * `workflow` is what allows commits that touch `.github/workflows/*` (GitHub
 * rejects such a push with a `refusing to allow an OAuth App to create or
 * update workflow` error otherwise).
 *
 * Adding a scope here only takes effect on a *new* authorization: GitHub
 * grants are additive and already-stored tokens keep their old scope set, so
 * existing users must sign out and back in (which triggers GitHub's consent
 * screen for the added scope). */
const GITHUB_OAUTH_SCOPES = "repo workflow read:user read:org";

/** CLI login sends the freshly-minted JWT to a loopback listener instead of
 * the dashboard. Only ever redirect to the caller's own machine — never an
 * arbitrary host — so a crafted `cli` param can't exfiltrate a token. */
function isLoopbackRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname;
    return (
      host === "127.0.0.1" ||
      host === "localhost" ||
      host === "::1" ||
      host === "[::1]"
    );
  } catch {
    return false;
  }
}

/** Append `token` to a loopback callback URL, preserving any existing query. */
function cliCallbackUrl(redirect: string, token: string): string {
  const sep = redirect.includes("?") ? "&" : "?";
  return `${redirect}${sep}token=${encodeURIComponent(token)}`;
}

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
    // Default toolbox seeding disabled for now (toolboxes are created
    // explicitly, not mandated as an org baseline).
  }

  const authRoutes = new Elysia({ prefix: "/auth" })
    .get(
      "/github",
      async ({ redirect, cookie, query }) => {
        const cliRedirect =
          query.cli && isLoopbackRedirect(query.cli) ? query.cli : undefined;

        if (isAuthBypassed()) {
          const token = await signJwt({
            id: MOCK_USER.githubId,
            username: MOCK_USER.username,
            avatarUrl: MOCK_USER.avatarUrl,
            email: MOCK_USER.email,
          });

          userService.upsertFromLogin(
            MOCK_USER.githubId,
            MOCK_USER.username,
            MOCK_USER.email,
            MOCK_USER.avatarUrl,
            MOCK_USER.accessToken,
          );
          ensurePersonalOrg(MOCK_USER.githubId, MOCK_USER.username);

          // CLI login: hand the token straight back to the loopback listener
          // (no browser session/cookie needed for the CLI).
          if (cliRedirect) {
            log.info("Mock: CLI login as mock-user");
            return redirect(cliCallbackUrl(cliRedirect, token));
          }

          // Same-origin over http://localhost (console nginx proxies to the
          // server): `SameSite=None` REQUIRES `Secure`, which browsers reject
          // on plain http — so the cookie would silently never be stored and
          // the console would loop back to the login screen. `lax` is correct
          // for a same-origin session cookie and works without `Secure`.
          cookie.sandbox_token?.set({
            value: token,
            httpOnly: true,
            secure: false,
            sameSite: "lax",
            path: "/",
            maxAge: JWT_EXPIRY_SECONDS,
          });

          log.info("Auth bypassed: user auto-logged in as local user");
          return redirect("/");
        }

        // Carry the loopback target through the OAuth roundtrip so the callback
        // can return the JWT to the CLI instead of the dashboard.
        if (cliRedirect) {
          cookie.cli_redirect?.set({
            value: cliRedirect,
            httpOnly: true,
            secure: isProduction(),
            sameSite: isProduction() ? "none" : "lax",
            path: "/",
            domain: `.${config.domain.baseDomain}`,
            maxAge: 600,
          });
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
          GITHUB_OAUTH_SCOPES,
          {
            state: nanoid(16),
            code_challenge: codeChallenge,
            code_challenge_method: "S256",
          },
        );
        return redirect(url);
      },
      { query: t.Object({ cli: t.Optional(t.String()) }) },
    )
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

          // CLI login: bounce the token to the loopback listener instead of
          // the dashboard, then clear the marker cookie.
          const cliRedirect = cookie.cli_redirect?.value as string | undefined;
          if (cliRedirect && isLoopbackRedirect(cliRedirect)) {
            cookie.cli_redirect?.set({
              value: "",
              httpOnly: true,
              secure: isProduction(),
              sameSite: isProduction() ? "none" : "lax",
              path: "/",
              domain: `.${config.domain.baseDomain}`,
              maxAge: 0,
            });
            return redirect(cliCallbackUrl(cliRedirect, token));
          }
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
    // Public: lets the console detect an auth-bypassed (local/mock) server so
    // it can drop the user straight in instead of showing a GitHub button.
    .get("/mode", () => ({ bypassed: isAuthBypassed() }))
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
  return authRoutes;
}
