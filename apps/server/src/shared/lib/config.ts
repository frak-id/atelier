import {
  loadConfig,
  loadProvidedConfig,
} from "@frak/atelier-shared/config-loader";

export const config = loadConfig();

/** The operator-provided config (file + env, no schema defaults). Lets the
 * runtime config plane tell an explicitly-set key (lock it read-only) from one
 * left at its default (editable from the console). */
export const providedConfig = loadProvidedConfig();

/** Real cluster runtime + GitHub OAuth + secure cookies. */
export const isProduction = () => config.server.mode === "production";

/** Auth is bypassed (fixed local user, any token accepted) in `local` mode:
 * the single-user laptop mode with the real runtime (usually the Docker
 * backend), no GitHub OAuth app, and no SSH gateway. */
export const isAuthBypassed = () => config.server.mode === "local";

export const dashboardUrl = config.domain.dashboard.includes("localhost")
  ? `http://${config.domain.dashboard}`
  : `https://${config.domain.dashboard}`;

export function deriveCallbackUrl(path: string) {
  if (config.domain.dashboard.includes("localhost")) {
    return `http://localhost:${config.server.port}${path}`;
  }
  return `https://${config.domain.dashboard}${path}`;
}
