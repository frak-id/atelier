import { PATHS, NETWORK, CADDY, DEFAULTS } from "@frak-sandbox/shared/constants";

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

  isMock: () => config.mode === "mock",
  isProduction: () => config.mode === "production",
} as const;
