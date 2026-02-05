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

const DEFAULT_CALLBACK_URL = "http://localhost:4000/api/github/callback";
const DEFAULT_LOGIN_CALLBACK_URL = "http://localhost:4000/auth/callback";

function resolveCallbackUrl(
  explicitUrl: string,
  defaultUrl: string,
  path: string,
): string {
  if (explicitUrl && explicitUrl !== defaultUrl) return explicitUrl;
  const domain = atelierConfig.domains.dashboard;
  if (domain.includes("localhost")) return defaultUrl;
  return `https://${domain}${path}`;
}

export const config = {
  mode: getMode(),
  port: atelierConfig.runtime.port,
  host: atelierConfig.runtime.host,

  paths: PATHS,
  network: atelierConfig.network,
  caddy: {
    adminApi: atelierConfig.caddy.adminApi,
    domainSuffix: atelierConfig.domains.sandboxSuffix,
  },
  domains: atelierConfig.domains,
  sshProxy: atelierConfig.sshProxy,
  defaults: DEFAULTS,

  github: {
    clientId: atelierConfig.auth.githubClientId,
    clientSecret: atelierConfig.auth.githubClientSecret,
    callbackUrl: resolveCallbackUrl(
      atelierConfig.auth.githubCallbackUrl,
      DEFAULT_CALLBACK_URL,
      "/api/github/callback",
    ),
    loginCallbackUrl: resolveCallbackUrl(
      atelierConfig.auth.githubLoginCallbackUrl,
      DEFAULT_LOGIN_CALLBACK_URL,
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
