import {
  CADDY,
  DEFAULTS,
  NETWORK,
  PATHS,
} from "@frak-sandbox/shared/constants";

export type Mode = "production" | "mock";

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
  defaults: DEFAULTS,

  github: {
    clientId: process.env.GITHUB_CLIENT_ID || "",
    clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
    callbackUrl:
      process.env.GITHUB_CALLBACK_URL ||
      "http://localhost:4000/auth/github/callback",
  },

  dashboardUrl: process.env.DASHBOARD_URL || "http://localhost:5173",

  isMock: () => config.mode === "mock",
  isProduction: () => config.mode === "production",
} as const;
