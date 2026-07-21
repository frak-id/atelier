import { loadConfig, loadProvidedConfig } from "@frak/atelier-shared";

export const config = loadConfig();

/** The operator-provided config (file + env, no schema defaults). Lets the
 * runtime config plane tell an explicitly-set key (lock it read-only) from one
 * left at its default (editable from the console). */
export const providedConfig = loadProvidedConfig();

export const isMock = () => config.server.mode === "mock";
export const isProduction = () => config.server.mode === "production";

export const dashboardUrl = config.domain.dashboard.includes("localhost")
  ? `http://${config.domain.dashboard}`
  : `https://${config.domain.dashboard}`;

export function deriveCallbackUrl(path: string) {
  if (config.domain.dashboard.includes("localhost")) {
    return `http://localhost:${config.server.port}${path}`;
  }
  return `https://${config.domain.dashboard}${path}`;
}
