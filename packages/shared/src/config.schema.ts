/**
 * Unified configuration schema for FRAK Sandbox.
 * Configuration priority: ENV vars > config file > defaults
 */
import { type Static, Type } from "@sinclair/typebox";

export const DomainsConfigSchema = Type.Object({
  /** API domain (e.g., sandbox-api.example.com) */
  api: Type.String({ default: "sandbox-api.localhost" }),
  /** Dashboard domain (e.g., sandbox-dash.example.com) */
  dashboard: Type.String({ default: "sandbox-dash.localhost" }),
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
    default: "http://localhost:4000/auth/github/callback",
  }),
  /** GitHub login callback URL */
  githubLoginCallbackUrl: Type.String({
    default: "http://localhost:4000/auth/login/callback",
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
  Type.Object({
    port: Type.Number({ default: defaultPort }),
  });

export const ServicesConfigSchema = Type.Object({
  vscode: ServiceEntrySchema(8080),
  opencode: ServiceEntrySchema(3000),
  terminal: ServiceEntrySchema(7681),
  agent: ServiceEntrySchema(9999),
});

export type ServicesConfig = Static<typeof ServicesConfigSchema>;

export const FrakConfigSchema = Type.Object({
  domains: DomainsConfigSchema,
  network: NetworkConfigSchema,
  auth: AuthConfigSchema,
  sshProxy: SshProxyConfigSchema,
  runtime: RuntimeConfigSchema,
  tls: TlsConfigSchema,
  services: ServicesConfigSchema,
});

export type FrakConfig = Static<typeof FrakConfigSchema>;

/** Maps environment variable names to config paths for the config loader */
export const ENV_VAR_MAPPING = {
  FRAK_API_DOMAIN: "domains.api",
  FRAK_DASHBOARD_DOMAIN: "domains.dashboard",
  FRAK_SANDBOX_DOMAIN_SUFFIX: "domains.sandboxSuffix",
  FRAK_SSH_DOMAIN: "domains.ssh",

  FRAK_BRIDGE_NAME: "network.bridgeName",
  FRAK_BRIDGE_IP: "network.bridgeIp",
  FRAK_BRIDGE_CIDR: "network.bridgeCidr",
  FRAK_GUEST_SUBNET: "network.guestSubnet",
  FRAK_GUEST_IP_START: "network.guestIpStart",
  FRAK_DNS_SERVERS: "network.dnsServers", // comma-separated

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

  FRAK_VSCODE_PORT: "services.vscode.port",
  FRAK_OPENCODE_PORT: "services.opencode.port",
  FRAK_TERMINAL_PORT: "services.terminal.port",
  FRAK_AGENT_PORT: "services.agent.port",
} as const;

export type EnvVarName = keyof typeof ENV_VAR_MAPPING;

export const DEFAULT_CONFIG: FrakConfig = {
  domains: {
    api: "sandbox-api.localhost",
    dashboard: "sandbox-dash.localhost",
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
    githubCallbackUrl: "http://localhost:4000/auth/github/callback",
    githubLoginCallbackUrl: "http://localhost:4000/auth/login/callback",
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
    terminal: { port: 7681 },
    agent: { port: 9999 },
  },
};
