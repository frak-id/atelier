/**
 * `/auth/*` — the GitHub OAuth login surface. Unauthenticated by definition
 * (it's how a caller *gets* a token): mints the `sandbox_token` JWT the rest
 * of `/v1`, `/api`, `/sessions` require.
 *
 * ACP/console-scoped: no cliproxy user-key bootstrap. `/auth/forward` is the
 * forward-auth check for sandbox tool URLs (see `forward-auth.ts`); a login
 * started from one carries `return_to` so the callback lands back on it.
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
import {
  decideForwardAuth,
  decideWake,
  type ForwardedRequest,
  isReturnUrl,
  sandboxIdFromHost,
  WAKE_RETRY_AFTER_SECONDS,
  wakePage,
} from "./forward-auth.ts";

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

/** A post-login destination under the base domain (a sandbox tool URL the
 * forward-auth check sent to the login), or `undefined`. */
function returnUrlOf(url: string | undefined): string | undefined {
  return url && isReturnUrl(url, config.domain.baseDomain, !isProduction())
    ? url
    : undefined;
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

  /** Bootstrap a personal org + owner membership on a user's first login;
   * a new user also joins the team org (`auth.defaultOrg`) as a member. */
  function bootstrapOrgs(userId: string, login: string): void {
    if (!ensurePersonalOrg(userId, login)) return;
    container.control.defaultOrg.joinDefaultOrg(userId);
  }

  /** Returns whether the personal org was just created. */
  function ensurePersonalOrg(userId: string, login: string): boolean {
    const user = userService.getById(userId);
    if (user?.personalOrgId) return false;
    const personalOrg = organizationService.create(
      login,
      login.toLowerCase(),
      true,
    );
    userService.setPersonalOrg(userId, personalOrg.id);
    orgMemberService.addMember(personalOrg.id, userId, "owner");
    return true;
  }

  /** The 200/503 answer to "may this request reach the sandbox now?": a
   * paused sandbox is resumed and the caller told to retry. */
  function wakeReply(
    sandboxId: string | undefined,
    forwarded: ForwardedRequest,
    set: { status?: number | string; headers: Record<string, unknown> },
  ): string | { error: string; message: string } {
    const status = sandboxId
      ? container.runtime.getStatus(sandboxId)
      : undefined;
    const decision = decideWake(status, forwarded);
    if (decision.status === 200 || !sandboxId) return "";
    container.sandboxOps.wake(sandboxId);
    set.status = 503;
    set.headers["retry-after"] = String(WAKE_RETRY_AFTER_SECONDS);
    if (!decision.page) {
      return {
        error: "SANDBOX_WAKING",
        message: "The sandbox is waking up; retry shortly",
      };
    }
    set.headers["content-type"] = "text/html; charset=utf-8";
    return wakePage();
  }

  /** The X-Forwarded-* view of the request the ingress is asking about. */
  const forwardedOf = (headers: Record<string, string | undefined>) => ({
    proto: headers["x-forwarded-proto"],
    host: headers["x-forwarded-host"],
    uri: headers["x-forwarded-uri"],
    method: headers["x-forwarded-method"],
    accept: headers.accept,
  });

  const authRoutes = new Elysia({ prefix: "/auth" })
    .get(
      "/github",
      async ({ redirect, cookie, query }) => {
        const returnTo = returnUrlOf(query.return_to);

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
          bootstrapOrgs(MOCK_USER.githubId, MOCK_USER.username);

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
          return redirect(returnTo ?? "/");
        }

        // A login a sandbox tool URL sent here (forward-auth) carries its
        // destination through the OAuth roundtrip.
        if (returnTo) {
          cookie.auth_return_to?.set({
            value: returnTo,
            httpOnly: true,
            secure: isProduction(),
            sameSite: "lax",
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
      {
        query: t.Object({
          return_to: t.Optional(t.String()),
        }),
      },
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
          bootstrapOrgs(String(ghUser.id), ghUser.login);

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

          const returnTo = returnUrlOf(
            cookie.auth_return_to?.value as string | undefined,
          );
          if (returnTo) {
            cookie.auth_return_to?.set({
              value: "",
              httpOnly: true,
              secure: isProduction(),
              sameSite: "lax",
              path: "/",
              domain: `.${config.domain.baseDomain}`,
              maxAge: 0,
            });
            return redirect(returnTo);
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
        // Server admin: the console hides admin-only actions without it.
        admin: container.control.defaultOrg.isServerAdmin(user.id),
      };
    })
    // Forward-auth for sandbox tool URLs (`ports[].auth: "forward"`), asked by
    // the ingress before each request: 200 lets it through, a browser page
    // load without a session is sent to the login, the rest gets 401.
    .get("/forward", async ({ cookie, headers, set, redirect }) => {
      const token = cookie.sandbox_token?.value as string | undefined;
      const user = token ? await verifyJwt(token) : null;
      const signedIn = isAuthBypassed() || user !== null;
      const forwarded = forwardedOf(headers);
      const decision = decideForwardAuth({
        signedIn,
        forwarded,
        loginUrl: deriveCallbackUrl("/auth/github"),
        baseDomain: config.domain.baseDomain,
        allowHttp: !isProduction(),
      });
      set.headers["cache-control"] = "no-store";
      if (decision.status === 302) return redirect(decision.location);
      if (decision.status === 200) {
        // Signed in: a paused sandbox the caller may reach wakes up.
        const sandboxId = sandboxIdFromHost(
          forwarded.host,
          config.domain.baseDomain,
        );
        const labels = sandboxId
          ? container.runtime.getLabels(sandboxId)
          : undefined;
        const mayWake =
          labels !== undefined &&
          (isAuthBypassed() ||
            (user !== null &&
              container.control.canAccessSandbox(user.id, labels)));
        return mayWake ? wakeReply(sandboxId, forwarded, set) : "";
      }
      set.status = decision.status;
      return { error: "UNAUTHORIZED", message: "Sign in to Atelier first" };
    })
    // Wake-only check for public preview URLs (no login, ever): 200 while the
    // sandbox runs, a paused one is resumed and answered 503 like above.
    .get("/wake", ({ headers, set }) => {
      set.headers["cache-control"] = "no-store";
      const forwarded = forwardedOf(headers);
      return wakeReply(
        sandboxIdFromHost(forwarded.host, config.domain.baseDomain),
        forwarded,
        set,
      );
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
    });
  return authRoutes;
}
