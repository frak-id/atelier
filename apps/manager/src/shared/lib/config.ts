import { loadConfig } from "@frak/atelier-shared";
import { CADDY, DEFAULTS, PATHS } from "@frak/atelier-shared/constants";

const atelierConfig = loadConfig();

type Mode = "production" | "mock";

function getMode(): Mode {
  if (
    atelierConfig.runtime.mode === "production" ||
    atelierConfig.runtime.mode === "mock"
  ) {
    return atelierConfig.runtime.mode;
  }
  return process.env.NODE_ENV === "production" ? "production" : "mock";
}

function deriveCallbackUrl(dashboard: string, port: number, path: string) {
  if (dashboard.includes("localhost")) return `http://localhost:${port}${path}`;
  return `https://${dashboard}${path}`;
}

export const config = {
  mode: getMode(),
  port: atelierConfig.runtime.port,
  host: atelierConfig.runtime.host,

  paths: PATHS,
  network: atelierConfig.network,
  caddy: {
    adminApi: CADDY.ADMIN_API,
    domainSuffix: atelierConfig.domains.sandboxSuffix,
  },
  domains: atelierConfig.domains,
  sshProxy: atelierConfig.sshProxy,
  defaults: DEFAULTS,

  github: {
    clientId: atelierConfig.auth.githubClientId,
    clientSecret: atelierConfig.auth.githubClientSecret,
    callbackUrl: deriveCallbackUrl(
      atelierConfig.domains.dashboard,
      atelierConfig.runtime.port,
      "/api/github/callback",
    ),
    loginCallbackUrl: deriveCallbackUrl(
      atelierConfig.domains.dashboard,
      atelierConfig.runtime.port,
      "/auth/callback",
    ),
  },

  auth: {
    jwtSecret: atelierConfig.auth.jwtSecret,
    allowedOrg: atelierConfig.auth.allowedOrg,
    allowedUsers: atelierConfig.auth.allowedUsers,
  },

  dashboardUrl: `https://${atelierConfig.domains.dashboard}`,

  git: atelierConfig.git,

  images: atelierConfig.images,

  isMock: () => config.mode === "mock",
  isProduction: () => config.mode === "production",

  raw: atelierConfig,
} as const;
