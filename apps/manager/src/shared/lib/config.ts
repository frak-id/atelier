import { loadConfig } from "@frak/atelier-shared";
import { CADDY, DEFAULTS, PATHS } from "@frak/atelier-shared/constants";

const atelierConfig = loadConfig();

type Mode = "production" | "mock";

function getMode(): Mode {
  if (
    atelierConfig.server.mode === "production" ||
    atelierConfig.server.mode === "mock"
  ) {
    return atelierConfig.server.mode;
  }
  return process.env.NODE_ENV === "production" ? "production" : "mock";
}

function deriveCallbackUrl(dashboard: string, port: number, path: string) {
  if (dashboard.includes("localhost")) return `http://localhost:${port}${path}`;
  return `https://${dashboard}${path}`;
}

export const config = {
  mode: getMode(),
  port: atelierConfig.server.port,
  host: atelierConfig.server.host,
  maxSandboxes: atelierConfig.server.maxSandboxes,

  paths: PATHS,
  network: atelierConfig.network,
  caddy: {
    adminApi: CADDY.ADMIN_API,
    domainSuffix: atelierConfig.domain.baseDomain,
  },
  domains: {
    dashboard: atelierConfig.domain.dashboard,
    sandboxSuffix: atelierConfig.domain.baseDomain,
  },
  sshProxy: {
    domain: atelierConfig.domain.ssh.hostname,
    port: atelierConfig.domain.ssh.port,
  },
  defaults: DEFAULTS,

  github: {
    clientId: atelierConfig.auth.github.clientId,
    clientSecret: atelierConfig.auth.github.clientSecret,
    callbackUrl: deriveCallbackUrl(
      atelierConfig.domain.dashboard,
      atelierConfig.server.port,
      "/api/github/callback",
    ),
    loginCallbackUrl: deriveCallbackUrl(
      atelierConfig.domain.dashboard,
      atelierConfig.server.port,
      "/auth/callback",
    ),
  },

  auth: {
    jwtSecret: atelierConfig.auth.jwtSecret,
    allowedOrg: atelierConfig.auth.allowedOrg,
    allowedUsers: atelierConfig.auth.allowedUsers,
  },

  dashboardUrl: `https://${atelierConfig.domain.dashboard}`,

  git: atelierConfig.sandbox.git,

  images: {
    directory: atelierConfig.sandbox.imagesDirectory,
    defaultImage: atelierConfig.sandbox.defaultImage,
  },

  services: {
    vscode: { port: atelierConfig.advanced.vm.vscode.port },
    opencode: { port: atelierConfig.advanced.vm.opencode.port },
    browser: { port: atelierConfig.advanced.vm.browser.port },
    terminal: { port: atelierConfig.advanced.vm.terminal.port },
    agent: { port: atelierConfig.advanced.vm.agent.port },
    verdaccio: { port: atelierConfig.advanced.server.verdaccio.port },
  },

  versions: {
    opencode: atelierConfig.advanced.vm.opencode.version,
    codeServer: atelierConfig.advanced.vm.vscode.version,
    verdaccio: atelierConfig.advanced.server.verdaccio.version,
    firecracker: atelierConfig.advanced.server.firecracker.version,
    sshProxy: atelierConfig.advanced.server.sshProxy.version,
  },

  isMock: () => config.mode === "mock",
  isProduction: () => config.mode === "production",

  raw: atelierConfig,
} as const;
