import { loadConfig } from "@frak/atelier-shared";
import { DEFAULTS, PATHS } from "@frak/atelier-shared/constants";

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

export const config = {
  mode: getMode(),
  port: atelierConfig.runtime.port,
  host: atelierConfig.runtime.host,

  paths: PATHS,
  network: atelierConfig.network,
  caddy: {
    adminApi: process.env.CADDY_ADMIN_API || "http://localhost:2019",
    domainSuffix: atelierConfig.domains.sandboxSuffix,
  },
  domains: atelierConfig.domains,
  sshProxy: atelierConfig.sshProxy,
  defaults: DEFAULTS,

  github: {
    clientId: atelierConfig.auth.githubClientId,
    clientSecret: atelierConfig.auth.githubClientSecret,
    callbackUrl: atelierConfig.auth.githubCallbackUrl,
    loginCallbackUrl: atelierConfig.auth.githubLoginCallbackUrl,
  },

  auth: {
    jwtSecret: atelierConfig.auth.jwtSecret,
    allowedOrg: atelierConfig.auth.allowedOrg,
    allowedUsers: atelierConfig.auth.allowedUsers,
  },

  dashboardUrl: `https://${atelierConfig.domains.dashboard}`,

  images: atelierConfig.images,

  isMock: () => config.mode === "mock",
  isProduction: () => config.mode === "production",

  raw: atelierConfig,
} as const;
