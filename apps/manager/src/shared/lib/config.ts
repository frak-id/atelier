import {
  CADDY,
  DEFAULTS,
  NETWORK,
  PATHS,
  SSH_PROXY,
} from "@frak-sandbox/shared/constants";

type Mode = "production" | "mock";

function getMode(): Mode {
  const mode = process.env.SANDBOX_MODE;
  if (mode === "mock" || mode === "production") return mode;
  return process.env.NODE_ENV === "production" ? "production" : "mock";
}

export const config = {
  mode: getMode(),
  port: Number(process.env.PORT) || 4000,
  host: process.env.HOST || "0.0.0.0",

  paths: PATHS,
  network: NETWORK,
  caddy: {
    adminApi: process.env.CADDY_ADMIN_API || CADDY.ADMIN_API,
    domainSuffix: process.env.SANDBOX_DOMAIN || CADDY.DOMAIN_SUFFIX,
  },
  sshProxy: {
    pipesFile: process.env.SSH_PROXY_PIPES_FILE || SSH_PROXY.PIPES_FILE,
    domain: process.env.SSH_PROXY_DOMAIN || SSH_PROXY.DOMAIN,
    port: Number(process.env.SSH_PROXY_PORT) || SSH_PROXY.LISTEN_PORT,
  },
  defaults: DEFAULTS,

  github: {
    clientId: process.env.GITHUB_CLIENT_ID || "",
    clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
    callbackUrl:
      process.env.GITHUB_CALLBACK_URL ||
      "http://localhost:4000/auth/github/callback",
    loginCallbackUrl:
      process.env.GITHUB_LOGIN_CALLBACK_URL ||
      "http://localhost:4000/auth/login/callback",
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET || "dev-secret-change-in-production",
    // Allowed GitHub org or specific usernames as fallback
    allowedOrg: process.env.AUTH_ALLOWED_ORG || "frak-id",
    allowedUsers: (process.env.AUTH_ALLOWED_USERS || "srod,konfeature,mviala")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean),
  },

  dashboardUrl: process.env.DASHBOARD_URL || "http://localhost:5173",

  isMock: () => config.mode === "mock",
  isProduction: () => config.mode === "production",
} as const;
