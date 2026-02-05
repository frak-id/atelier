/**
 * Unified configuration schema for L'atelier.
 * Configuration priority: ENV vars > config file > defaults
 */
import { type Static, Type } from "@sinclair/typebox";

export const DomainsConfigSchema = Type.Object({
  /** Dashboard domain (e.g., sandbox.example.com) - API is served at /api on same domain */
  dashboard: Type.String({ default: "sandbox.localhost" }),
  /** Suffix for sandbox subdomains (e.g., example.com -> sandbox-{id}.example.com) */
  sandboxSuffix: Type.String({ default: "localhost" }),
  /** SSH proxy domain (e.g., ssh.example.com) */
  ssh: Type.String({ default: "ssh.localhost" }),
});

export type DomainsConfig = Static<typeof DomainsConfigSchema>;

export const NetworkConfigSchema = Type.Object({
  /** Bridge device name */
  bridgeName: Type.String({ default: "br0" }),
  /** Bridge IP address (host-side, e.g., 172.16.0.1) */
  bridgeIp: Type.String({ default: "172.16.0.1" }),
  /** Bridge network CIDR (e.g., 172.16.0.0/24) */
  bridgeCidr: Type.String({ default: "172.16.0.0/24" }),
  /** Bridge netmask without slash (e.g., 24) */
  bridgeNetmask: Type.String({ default: "24" }),
  /** Guest subnet prefix without last octet (e.g., 172.16.0) */
  guestSubnet: Type.String({ default: "172.16.0" }),
  /** First guest IP last octet - guests get .10, .11, etc. */
  guestIpStart: Type.Number({ default: 10 }),
  /** DNS servers for guest VMs */
  dnsServers: Type.Array(Type.String(), { default: ["8.8.8.8", "8.8.4.4"] }),
});

export type NetworkConfig = Static<typeof NetworkConfigSchema>;

export const AuthConfigSchema = Type.Object({
  /** GitHub OAuth client ID */
  githubClientId: Type.String({ default: "" }),
  /** GitHub OAuth client secret */
  githubClientSecret: Type.String({ default: "" }),
  /** GitHub OAuth callback URL */
  githubCallbackUrl: Type.String({
    default: "http://localhost:4000/api/github/callback",
  }),
  /** GitHub login callback URL */
  githubLoginCallbackUrl: Type.String({
    default: "http://localhost:4000/auth/callback",
  }),
  /** JWT signing secret */
  jwtSecret: Type.String({ default: "dev-secret-change-in-production" }),
  /** Required GitHub organization - if set, only org members can access */
  allowedOrg: Type.Optional(Type.String()),
  /** Allowed GitHub usernames as fallback if org check fails */
  allowedUsers: Type.Array(Type.String(), { default: [] }),
});

export type AuthConfig = Static<typeof AuthConfigSchema>;

export const SshProxyConfigSchema = Type.Object({
  /** SSH proxy listen port */
  port: Type.Number({ default: 2222 }),
  /** SSH proxy domain for external connections */
  domain: Type.String({ default: "ssh.localhost" }),
  /** Path to sshpiper pipes configuration */
  pipesFile: Type.String({ default: "/var/lib/sandbox/sshpiper/pipes.yaml" }),
});

export type SshProxyConfig = Static<typeof SshProxyConfigSchema>;

export const StorageSetupSchema = Type.Object({
  /** Storage backend for setup */
  method: Type.Optional(
    Type.Union([Type.Literal("loop"), Type.Literal("device")]),
  ),
  /** Loop file size in GB (when method=loop) */
  loopSizeGb: Type.Optional(Type.Number({ minimum: 10 })),
  /** Block device path (when method=device) */
  device: Type.Optional(Type.String()),
});

export type StorageSetup = Static<typeof StorageSetupSchema>;

export const NetworkSetupSchema = Type.Object({
  /** Behavior when the bridge already exists */
  onExists: Type.Optional(
    Type.Union([Type.Literal("status"), Type.Literal("recreate")]),
  ),
});

export type NetworkSetup = Static<typeof NetworkSetupSchema>;

export const SetupConfigSchema = Type.Object(
  {
    storage: Type.Optional(StorageSetupSchema),
    network: Type.Optional(NetworkSetupSchema),
  },
  { default: {} },
);

export type SetupConfig = Static<typeof SetupConfigSchema>;

export const RuntimeModeSchema = Type.Union([
  Type.Literal("production"),
  Type.Literal("mock"),
]);

export type RuntimeMode = Static<typeof RuntimeModeSchema>;

export const RuntimeConfigSchema = Type.Object({
  /** Runtime mode: production (real VMs) or mock (local dev) */
  mode: RuntimeModeSchema,
  /** Manager API port */
  port: Type.Number({ default: 4000 }),
  /** Manager API bind host */
  host: Type.String({ default: "0.0.0.0" }),
});

export type RuntimeConfig = Static<typeof RuntimeConfigSchema>;

export const TlsConfigSchema = Type.Object({
  /** Email for TLS certificate (e.g., ACME / Let's Encrypt) */
  email: Type.String({ default: "" }),
  /** Path to TLS certificate PEM file */
  certPath: Type.String({ default: "" }),
  /** Path to TLS private key file */
  keyPath: Type.String({ default: "" }),
});

export type TlsConfig = Static<typeof TlsConfigSchema>;

const ServiceEntrySchema = (defaultPort: number) =>
  Type.Object(
    {
      port: Type.Number({ default: defaultPort }),
    },
    { default: {} },
  );

export const ServicesConfigSchema = Type.Object(
  {
    vscode: ServiceEntrySchema(8080),
    opencode: ServiceEntrySchema(3000),
    browser: ServiceEntrySchema(6080),
    terminal: ServiceEntrySchema(7681),
    agent: ServiceEntrySchema(9999),
  },
  { default: {} },
);

export type ServicesConfig = Static<typeof ServicesConfigSchema>;

export const SandboxServiceEntrySchema = Type.Object({
  port: Type.Optional(Type.Number()),
  command: Type.Optional(Type.String()),
  user: Type.Optional(Type.Union([Type.Literal("dev"), Type.Literal("root")])),
  autoStart: Type.Optional(Type.Boolean({ default: false })),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  enabled: Type.Optional(Type.Boolean({ default: true })),
});

export type SandboxServiceEntry = Static<typeof SandboxServiceEntrySchema>;

export const CaddyConfigSchema = Type.Object(
  {
    adminApi: Type.String({ default: "http://localhost:2019" }),
  },
  { default: {} },
);

export type CaddyConfig = Static<typeof CaddyConfigSchema>;

export const GitConfigSchema = Type.Object(
  {
    email: Type.String({ default: "sandbox@atelier.dev" }),
    name: Type.String({ default: "Sandbox User" }),
  },
  { default: {} },
);

export type GitConfig = Static<typeof GitConfigSchema>;

export const VersionsConfigSchema = Type.Object(
  {
    firecracker: Type.String({ default: "1.14.0" }),
    opencode: Type.String({ default: "1.1.48" }),
    codeServer: Type.String({ default: "4.108.1" }),
    sshProxy: Type.String({ default: "1.5.1" }),
    verdaccio: Type.String({ default: "6.2.4" }),
  },
  { default: {} },
);

export type VersionsConfig = Static<typeof VersionsConfigSchema>;

export const ImagesConfigSchema = Type.Object(
  {
    /** Directory containing image definitions (each image is a subdirectory with Dockerfile + image.json) */
    directory: Type.String({ default: "/opt/atelier/infra/images" }),
    /** Default image to use when creating new workspaces */
    defaultImage: Type.String({ default: "dev-base" }),
  },
  { default: {} },
);

export type ImagesConfig = Static<typeof ImagesConfigSchema>;

export const AtelierConfigSchema = Type.Object({
  domains: DomainsConfigSchema,
  network: NetworkConfigSchema,
  auth: AuthConfigSchema,
  sshProxy: SshProxyConfigSchema,
  runtime: RuntimeConfigSchema,
  tls: TlsConfigSchema,
  services: ServicesConfigSchema,
  setup: SetupConfigSchema,
  images: ImagesConfigSchema,
  caddy: CaddyConfigSchema,
  git: GitConfigSchema,
  versions: VersionsConfigSchema,
});

export type AtelierConfig = Static<typeof AtelierConfigSchema>;

/** Maps environment variable names to config paths for the config loader */
export const ENV_VAR_MAPPING = {
  ATELIER_DASHBOARD_DOMAIN: "domains.dashboard",
  ATELIER_SANDBOX_DOMAIN_SUFFIX: "domains.sandboxSuffix",
  ATELIER_SSH_DOMAIN: "domains.ssh",

  ATELIER_BRIDGE_NAME: "network.bridgeName",
  ATELIER_BRIDGE_IP: "network.bridgeIp",
  ATELIER_BRIDGE_CIDR: "network.bridgeCidr",
  ATELIER_GUEST_SUBNET: "network.guestSubnet",
  ATELIER_GUEST_IP_START: "network.guestIpStart",
  ATELIER_DNS_SERVERS: "network.dnsServers", // comma-separated

  GITHUB_CLIENT_ID: "auth.githubClientId",
  GITHUB_CLIENT_SECRET: "auth.githubClientSecret",
  GITHUB_CALLBACK_URL: "auth.githubCallbackUrl",
  GITHUB_LOGIN_CALLBACK_URL: "auth.githubLoginCallbackUrl",
  JWT_SECRET: "auth.jwtSecret",
  AUTH_ALLOWED_ORG: "auth.allowedOrg",
  AUTH_ALLOWED_USERS: "auth.allowedUsers", // comma-separated

  SSH_PROXY_PORT: "sshProxy.port",
  SSH_PROXY_DOMAIN: "sshProxy.domain",
  SSH_PROXY_PIPES_FILE: "sshProxy.pipesFile",

  SANDBOX_MODE: "runtime.mode",
  PORT: "runtime.port",
  HOST: "runtime.host",

  TLS_EMAIL: "tls.email",
  TLS_CERT_PATH: "tls.certPath",
  TLS_KEY_PATH: "tls.keyPath",

  ATELIER_VSCODE_PORT: "services.vscode.port",
  ATELIER_OPENCODE_PORT: "services.opencode.port",
  ATELIER_BROWSER_PORT: "services.browser.port",
  ATELIER_TERMINAL_PORT: "services.terminal.port",
  ATELIER_AGENT_PORT: "services.agent.port",

  ATELIER_IMAGES_DIR: "images.directory",
  ATELIER_DEFAULT_IMAGE: "images.defaultImage",

  CADDY_ADMIN_API: "caddy.adminApi",

  ATELIER_GIT_EMAIL: "git.email",
  ATELIER_GIT_NAME: "git.name",

  ATELIER_VERSION_FIRECRACKER: "versions.firecracker",
  ATELIER_VERSION_OPENCODE: "versions.opencode",
  ATELIER_VERSION_CODE_SERVER: "versions.codeServer",
  ATELIER_VERSION_SSH_PROXY: "versions.sshProxy",
  ATELIER_VERSION_VERDACCIO: "versions.verdaccio",
} as const;

export type EnvVarName = keyof typeof ENV_VAR_MAPPING;

export const DEFAULT_CONFIG: AtelierConfig = {
  domains: {
    dashboard: "sandbox.localhost",
    sandboxSuffix: "localhost",
    ssh: "ssh.localhost",
  },
  network: {
    bridgeName: "br0",
    bridgeIp: "172.16.0.1",
    bridgeCidr: "172.16.0.0/24",
    bridgeNetmask: "24",
    guestSubnet: "172.16.0",
    guestIpStart: 10,
    dnsServers: ["8.8.8.8", "8.8.4.4"],
  },
  auth: {
    githubClientId: "",
    githubClientSecret: "",
    githubCallbackUrl: "http://localhost:4000/api/github/callback",
    githubLoginCallbackUrl: "http://localhost:4000/auth/callback",
    jwtSecret: "dev-secret-change-in-production",
    allowedOrg: undefined,
    allowedUsers: [],
  },
  sshProxy: {
    port: 2222,
    domain: "ssh.localhost",
    pipesFile: "/var/lib/sandbox/sshpiper/pipes.yaml",
  },
  runtime: {
    mode: "mock",
    port: 4000,
    host: "0.0.0.0",
  },
  tls: {
    email: "",
    certPath: "",
    keyPath: "",
  },
  services: {
    vscode: { port: 8080 },
    opencode: { port: 3000 },
    browser: { port: 6080 },
    terminal: { port: 7681 },
    agent: { port: 9999 },
  },
  setup: {},
  images: {
    directory: "/opt/atelier/infra/images",
    defaultImage: "dev-base",
  },
  caddy: {
    adminApi: "http://localhost:2019",
  },
  git: {
    email: "sandbox@atelier.dev",
    name: "Sandbox User",
  },
  versions: {
    firecracker: "1.14.0",
    opencode: "1.1.48",
    codeServer: "4.108.1",
    sshProxy: "1.5.1",
    verdaccio: "6.2.4",
  },
};
