import { Elysia, t } from "elysia";
import { config } from "../../lib/config.ts";
import { createChildLogger } from "../../lib/logger.ts";
import { GitHubAuthService } from "../../services/github-auth.ts";
import { AuthModel } from "./model.ts";

const log = createChildLogger("auth-route");

const STATE_COOKIE_NAME = "github_oauth_state";
const STATE_COOKIE_MAX_AGE = 300;

export const authRoutes = new Elysia({ prefix: "/auth" })
  .get("/github", async ({ cookie, redirect }) => {
    if (!config.github.clientId) {
      log.error("GitHub OAuth not configured - missing client ID");
      return redirect(`${config.dashboardUrl}?error=github_not_configured`);
    }

    const { url, state } = GitHubAuthService.getAuthorizationUrl();

    const stateCookie = cookie[STATE_COOKIE_NAME];
    if (stateCookie) {
      stateCookie.set({
        value: state,
        httpOnly: true,
        secure: config.isProduction(),
        sameSite: "lax",
        maxAge: STATE_COOKIE_MAX_AGE,
        path: "/",
      });
    }

    log.info("Redirecting to GitHub for authorization");
    return redirect(url);
  })
  .get(
    "/github/callback",
    async ({ query, cookie, redirect }) => {
      const { code, state } = query;

      const stateCookie = cookie[STATE_COOKIE_NAME];
      const storedState = stateCookie?.value;
      stateCookie?.remove();

      if (!storedState || storedState !== state) {
        log.warn(
          { providedState: state, storedState: !!storedState },
          "Invalid OAuth state parameter",
        );
        return redirect(`${config.dashboardUrl}?error=invalid_state`);
      }

      try {
        const tokenResponse =
          await GitHubAuthService.exchangeCodeForToken(code);
        const user = await GitHubAuthService.getUser(
          tokenResponse.access_token,
        );

        await GitHubAuthService.saveConnection(
          user,
          tokenResponse.access_token,
          tokenResponse.scope,
        );

        log.info({ login: user.login }, "GitHub OAuth completed successfully");
        return redirect(`${config.dashboardUrl}?github_connected=true`);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        log.error({ error: message }, "GitHub OAuth callback failed");
        return redirect(
          `${config.dashboardUrl}?error=oauth_failed&message=${encodeURIComponent(message)}`,
        );
      }
    },
    {
      query: AuthModel.callbackQuery,
    },
  )
  .get(
    "/github/status",
    async () => {
      const status = await GitHubAuthService.getConnectionStatus();
      return status;
    },
    {
      response: AuthModel.statusResponse,
    },
  )
  .post(
    "/github/logout",
    async () => {
      const deleted = await GitHubAuthService.deleteConnection();
      log.info({ deleted }, "GitHub logout requested");
      return { success: deleted };
    },
    {
      response: AuthModel.logoutResponse,
    },
  );
