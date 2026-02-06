import { loadConfig } from "@frak/atelier-shared";

export const config = loadConfig();

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
