import { type FrakConfig, loadConfig } from "@frak-sandbox/shared";
import { DEFAULTS, PATHS } from "@frak-sandbox/shared/constants";

const frakConfig = loadConfig();

type Mode = "production" | "mock";

function getMode(): Mode {
  if (
    frakConfig.runtime.mode === "production" ||
    frakConfig.runtime.mode === "mock"
  ) {
    return frakConfig.runtime.mode;
  }
  return process.env.NODE_ENV === "production" ? "production" : "mock";
}

export const config = {
  mode: getMode(),
  port: frakConfig.runtime.port,
  host: frakConfig.runtime.host,

  paths: PATHS,
  network: frakConfig.network,
  caddy: {
    adminApi: process.env.CADDY_ADMIN_API || "http://localhost:2019",
    domainSuffix: frakConfig.domains.sandboxSuffix,
  },
  domains: frakConfig.domains,
  sshProxy: frakConfig.sshProxy,
  defaults: DEFAULTS,

  github: {
    clientId: frakConfig.auth.githubClientId,
    clientSecret: frakConfig.auth.githubClientSecret,
    callbackUrl: frakConfig.auth.githubCallbackUrl,
    loginCallbackUrl: frakConfig.auth.githubLoginCallbackUrl,
  },

  auth: {
    jwtSecret: frakConfig.auth.jwtSecret,
    allowedOrg: frakConfig.auth.allowedOrg,
    allowedUsers: frakConfig.auth.allowedUsers,
  },

  dashboardUrl: `https://${frakConfig.domains.dashboard}`,

  isMock: () => config.mode === "mock",
  isProduction: () => config.mode === "production",

  raw: frakConfig,
} as const;

export type { FrakConfig };
