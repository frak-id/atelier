/**
 * Unified configuration schema for L'atelier.
 * Configuration priority: ENV vars > config file > defaults
 *
 * Sections:
 *   domain   — Where this runs (base domain, TLS, SSH)
 *   auth     — Who can access (GitHub OAuth, JWT, ACLs)
 *   server   — Manager API settings (mode, port, limits)
 *   network  — Bridge/guest networking
 *   sandbox  — Defaults for new sandboxes (image, git identity)
 *   setup    — One-time init options (storage, network bootstrap)
 *   advanced — Power-user overrides (VM service ports, versions)
 */
import { type Static, Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

export const TlsConfigSchema = Type.Object(
  {
    /** Email for TLS certificate (e.g., ACME / Let's Encrypt) */
    email: Type.String({ default: "" }),
    /** Path to TLS certificate PEM file (manual TLS) */
    certPath: Type.String({ default: "" }),
    /** Path to TLS private key file (manual TLS) */
    keyPath: Type.String({ default: "" }),
  },
  { default: {} },
);

export type TlsConfig = Static<typeof TlsConfigSchema>;

export const SshConfigSchema = Type.Object(
  {
    /** SSH proxy listen port */
    port: Type.Number({ default: 2222 }),
    /** SSH proxy hostname — defaults to ssh.{baseDomain} if empty */
    hostname: Type.String({ default: "" }),
  },
  { default: {} },
);

export type SshConfig = Static<typeof SshConfigSchema>;

export const DomainConfigSchema = Type.Object({
  /** Base domain for all services (e.g., example.com) */
  baseDomain: Type.String({ default: "localhost" }),
  /** Dashboard domain — defaults to sandbox.{baseDomain} if empty */
  dashboard: Type.String({ default: "" }),
  /** TLS / HTTPS configuration */
  tls: TlsConfigSchema,
  /** SSH proxy configuration */
  ssh: SshConfigSchema,
});

export type DomainConfig = Static<typeof DomainConfigSchema>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const GithubAuthConfigSchema = Type.Object(
  {
    /** GitHub OAuth client ID */
    clientId: Type.String({ default: "" }),
    /** GitHub OAuth client secret */
    clientSecret: Type.String({ default: "" }),
  },
  { default: {} },
);

export type GithubAuthConfig = Static<typeof GithubAuthConfigSchema>;

export const AuthConfigSchema = Type.Object({
  /** GitHub OAuth credentials */
  github: GithubAuthConfigSchema,
  /** JWT signing secret */
  jwtSecret: Type.String({ default: "dev-secret-change-in-production" }),
  /** Required GitHub organization — if set, only org members can access */
  allowedOrg: Type.Optional(Type.String()),
  /** Allowed GitHub usernames as fallback if org check fails */
  allowedUsers: Type.Array(Type.String(), { default: [] }),
});

export type AuthConfig = Static<typeof AuthConfigSchema>;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const RuntimeModeSchema = Type.Union([
  Type.Literal("production"),
  Type.Literal("mock"),
]);

export type RuntimeMode = Static<typeof RuntimeModeSchema>;

export const ServerConfigSchema = Type.Object({
  /** Runtime mode: production (real VMs) or mock (local dev) */
  mode: RuntimeModeSchema,
  /** Manager API port */
  port: Type.Number({ default: 4000 }),
  /** Manager API bind host */
  host: Type.String({ default: "0.0.0.0" }),
  /** Maximum concurrent sandboxes */
  maxSandboxes: Type.Number({ default: 20 }),
});

export type ServerConfig = Static<typeof ServerConfigSchema>;

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export const NetworkConfigSchema = Type.Object({
  /** Bridge IP address (host-side, e.g., 172.16.0.1) */
  bridgeIp: Type.String({ default: "172.16.0.1" }),
  /** Bridge device name */
  bridgeName: Type.String({ default: "br0" }),
  /** DNS servers for guest VMs */
  dnsServers: Type.Array(Type.String(), { default: ["8.8.8.8", "8.8.4.4"] }),
  /** First guest IP last octet — guests get .10, .11, etc. */
  guestIpStart: Type.Number({ default: 10 }),

  // Derived fields (computed from bridgeIp by the loader — do not set manually)
  /** @internal Guest subnet prefix without last octet (e.g., 172.16.0) */
  guestSubnet: Type.String({ default: "172.16.0" }),
  /** @internal Bridge network CIDR (e.g., 172.16.0.0/24) */
  bridgeCidr: Type.String({ default: "172.16.0.0/24" }),
  /** @internal Bridge netmask (e.g., 24) */
  bridgeNetmask: Type.String({ default: "24" }),
});

export type NetworkConfig = Static<typeof NetworkConfigSchema>;

// ---------------------------------------------------------------------------
// Sandbox defaults
// ---------------------------------------------------------------------------

export const SandboxGitConfigSchema = Type.Object(
  {
    /** Default git email for sandbox users */
    email: Type.String({ default: "sandbox@atelier.dev" }),
    /** Default git name for sandbox users */
    name: Type.String({ default: "Sandbox User" }),
  },
  { default: {} },
);

export type SandboxGitConfig = Static<typeof SandboxGitConfigSchema>;

export const SandboxDefaultsSchema = Type.Object(
  {
    /** Default image for new sandboxes */
    defaultImage: Type.String({ default: "dev-base" }),
    /** Directory containing image definitions */
    imagesDirectory: Type.String({ default: "/opt/atelier/infra/images" }),
    /** Default git identity injected into sandboxes */
    git: SandboxGitConfigSchema,
  },
  { default: {} },
);

export type SandboxDefaults = Static<typeof SandboxDefaultsSchema>;

// ---------------------------------------------------------------------------
// Setup (one-time init)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Advanced — VM services (inside sandbox)
// ---------------------------------------------------------------------------

const VmServiceWithVersion = (defaultPort: number, defaultVersion: string) =>
  Type.Object(
    {
      port: Type.Number({ default: defaultPort }),
      version: Type.String({ default: defaultVersion }),
    },
    { default: {} },
  );

const VmService = (defaultPort: number) =>
  Type.Object(
    {
      port: Type.Number({ default: defaultPort }),
    },
    { default: {} },
  );

export const AdvancedVmConfigSchema = Type.Object(
  {
    vscode: VmServiceWithVersion(8080, "4.108.1"),
    opencode: VmServiceWithVersion(3000, "1.1.48"),
    browser: VmService(6080),
    terminal: VmService(7681),
    agent: VmService(9999),
  },
  { default: {} },
);

export type AdvancedVmConfig = Static<typeof AdvancedVmConfigSchema>;

// ---------------------------------------------------------------------------
// Advanced — Server services (on host)
// ---------------------------------------------------------------------------

export const AdvancedServerConfigSchema = Type.Object(
  {
    verdaccio: Type.Object(
      {
        port: Type.Number({ default: 4873 }),
        version: Type.String({ default: "6.2.4" }),
      },
      { default: {} },
    ),
    sshProxy: Type.Object(
      {
        version: Type.String({ default: "1.5.1" }),
      },
      { default: {} },
    ),
    firecracker: Type.Object(
      {
        version: Type.String({ default: "1.14.0" }),
      },
      { default: {} },
    ),
  },
  { default: {} },
);

export type AdvancedServerConfig = Static<typeof AdvancedServerConfigSchema>;

export const AdvancedConfigSchema = Type.Object(
  {
    /** Services running inside each sandbox VM */
    vm: AdvancedVmConfigSchema,
    /** Services running on the host server */
    server: AdvancedServerConfigSchema,
  },
  { default: {} },
);

export type AdvancedConfig = Static<typeof AdvancedConfigSchema>;

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

export const AtelierConfigSchema = Type.Object({
  domain: DomainConfigSchema,
  auth: AuthConfigSchema,
  server: ServerConfigSchema,
  network: NetworkConfigSchema,
  sandbox: SandboxDefaultsSchema,
  setup: SetupConfigSchema,
  advanced: AdvancedConfigSchema,
});

export type AtelierConfig = Static<typeof AtelierConfigSchema>;

// ---------------------------------------------------------------------------
// Environment variable → config path mapping
// ---------------------------------------------------------------------------

export const ENV_VAR_MAPPING = {
  ATELIER_BASE_DOMAIN: "domain.baseDomain",
  ATELIER_DASHBOARD_DOMAIN: "domain.dashboard",
  TLS_EMAIL: "domain.tls.email",
  TLS_CERT_PATH: "domain.tls.certPath",
  TLS_KEY_PATH: "domain.tls.keyPath",
  SSH_PROXY_PORT: "domain.ssh.port",
  SSH_PROXY_DOMAIN: "domain.ssh.hostname",

  GITHUB_CLIENT_ID: "auth.github.clientId",
  GITHUB_CLIENT_SECRET: "auth.github.clientSecret",
  JWT_SECRET: "auth.jwtSecret",
  AUTH_ALLOWED_ORG: "auth.allowedOrg",
  AUTH_ALLOWED_USERS: "auth.allowedUsers",

  SANDBOX_MODE: "server.mode",
  PORT: "server.port",
  HOST: "server.host",
  MAX_SANDBOX: "server.maxSandboxes",

  ATELIER_BRIDGE_NAME: "network.bridgeName",
  ATELIER_BRIDGE_IP: "network.bridgeIp",
  ATELIER_GUEST_IP_START: "network.guestIpStart",
  ATELIER_DNS_SERVERS: "network.dnsServers",

  ATELIER_IMAGES_DIR: "sandbox.imagesDirectory",
  ATELIER_DEFAULT_IMAGE: "sandbox.defaultImage",
  ATELIER_GIT_EMAIL: "sandbox.git.email",
  ATELIER_GIT_NAME: "sandbox.git.name",

  ATELIER_VSCODE_PORT: "advanced.vm.vscode.port",
  ATELIER_OPENCODE_PORT: "advanced.vm.opencode.port",
  ATELIER_BROWSER_PORT: "advanced.vm.browser.port",
  ATELIER_TERMINAL_PORT: "advanced.vm.terminal.port",
  ATELIER_AGENT_PORT: "advanced.vm.agent.port",
  ATELIER_VERDACCIO_PORT: "advanced.server.verdaccio.port",

  ATELIER_VERSION_FIRECRACKER: "advanced.server.firecracker.version",
  ATELIER_VERSION_OPENCODE: "advanced.vm.opencode.version",
  ATELIER_VERSION_CODE_SERVER: "advanced.vm.vscode.version",
  ATELIER_VERSION_SSH_PROXY: "advanced.server.sshProxy.version",
  ATELIER_VERSION_VERDACCIO: "advanced.server.verdaccio.version",
} as const;

export type EnvVarName = keyof typeof ENV_VAR_MAPPING;
