/**
 * Unified configuration schema for Atelier.
 * Configuration priority: ENV vars > config file > defaults
 *
 * Sections:
 *   domain   — Where this runs (base domain, TLS, SSH)
 *   auth     — Who can access (GitHub OAuth, JWT, ACLs)
 *   server   — Manager API settings (mode, port, limits)
 *   sandbox  — Defaults for new sandboxes (image, git identity)
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

export const DomainConfigSchema = Type.Object(
  {
    /** Base domain for all services (e.g., example.com) */
    baseDomain: Type.String({ default: "localhost" }),
    /** Dashboard domain — defaults to sandbox.{baseDomain} if empty */
    dashboard: Type.String({ default: "" }),
    /** TLS / HTTPS configuration */
    tls: TlsConfigSchema,
    /** SSH proxy configuration */
    ssh: SshConfigSchema,
  },
  { default: {} },
);

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

export const AuthConfigSchema = Type.Object(
  {
    /** GitHub OAuth credentials */
    github: GithubAuthConfigSchema,
    /** JWT signing secret */
    jwtSecret: Type.String({ default: "dev-secret-change-in-production" }),
    /** Required GitHub organization — if set, only org members can access */
    allowedOrg: Type.Optional(Type.String()),
    /** Allowed GitHub usernames as fallback if org check fails */
    allowedUsers: Type.Array(Type.String(), { default: [] }),
  },
  { default: {} },
);

export type AuthConfig = Static<typeof AuthConfigSchema>;

// ---------------------------------------------------------------------------
// Kubernetes
// ---------------------------------------------------------------------------

export const KubernetesConfigSchema = Type.Object(
  {
    /** Namespace for sandbox pods */
    namespace: Type.String({ default: "atelier-sandboxes" }),
    /** Namespace for system components (Zot, Verdaccio, Kaniko jobs) */
    systemNamespace: Type.String({ default: "atelier-system" }),
    /** Path to kubeconfig file (ignored when running in-cluster) */
    kubeconfig: Type.String({ default: "/etc/rancher/k3s/k3s.yaml" }),
    /** Kata Containers runtime class name */
    runtimeClass: Type.String({ default: "kata-clh" }),
    /** Ingress class name for dynamically created ingresses (e.g., traefik, nginx) */
    ingressClassName: Type.String({ default: "" }),
    /** OCI registry hostname for sandbox and prebuild images (Zot) */
    registryUrl: Type.String({
      default: "zot.atelier-system.svc:5000",
    }),
    /** Full URL of the Verdaccio npm registry (e.g. http://verdaccio.atelier-system.svc:4873) */
    verdaccioUrl: Type.String({
      default: "http://verdaccio.atelier-system.svc:4873",
    }),
    /**
     * StorageClass for sandbox PVCs.
     * Recommend LVM thin provisioning (e.g. openebs-lvmpv) for
     * efficient disk usage. Empty string uses the cluster default.
     */
    storageClass: Type.String({ default: "" }),
    /**
     * VolumeSnapshotClass for prebuild snapshots.
     * Required for instant sandbox cloning from prebuilds.
     * Empty string uses the cluster default.
     */
    volumeSnapshotClass: Type.String({ default: "" }),
    /** Default PVC size for sandbox volumes (K8s quantity) */
    defaultVolumeSize: Type.String({ default: "10Gi" }),
    /** Annotations to apply to VS Code ingresses (e.g., forward-auth middleware) */
    vsCodeIngressAnnotations: Type.Record(Type.String(), Type.String(), {
      default: {},
    }),
    /** Annotations to apply to OpenCode ingresses (e.g., forward-auth + header injection) */
    openCodeIngressAnnotations: Type.Record(Type.String(), Type.String(), {
      default: {},
    }),
  },
  { default: {} },
);

export type KubernetesConfig = Static<typeof KubernetesConfigSchema>;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const RuntimeModeSchema = Type.Union([
  Type.Literal("production"),
  Type.Literal("mock"),
]);

export type RuntimeMode = Static<typeof RuntimeModeSchema>;

export const ServerConfigSchema = Type.Object(
  {
    /** Runtime mode: production (real VMs) or mock (local dev) */
    mode: RuntimeModeSchema,
    /** Manager API port */
    port: Type.Number({ default: 4000 }),
    /** Manager API bind host */
    host: Type.String({ default: "0.0.0.0" }),
    /** Maximum concurrent sandboxes */
    maxSandboxes: Type.Number({ default: 20 }),
    /** Maximum active tasks */
    maxActiveTasks: Type.Number({ default: 10 }),
    /** Bearer token for MCP server authentication — if empty, MCP auth is disabled */
    mcpToken: Type.String({ default: "" }),
  },
  { default: {} },
);

export type ServerConfig = Static<typeof ServerConfigSchema>;

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
// Ports — service ports inside sandbox VMs and on the host
// ---------------------------------------------------------------------------

export const PortsConfigSchema = Type.Object(
  {
    vscode: Type.Number({ default: 8080 }),
    opencode: Type.Number({ default: 3000 }),
    browser: Type.Number({ default: 6080 }),
    terminal: Type.Number({ default: 7681 }),
    agent: Type.Number({ default: 9998 }),
    verdaccio: Type.Number({ default: 4873 }),
  },
  { default: {} },
);

export type PortsConfig = Static<typeof PortsConfigSchema>;

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

export const SlackIntegrationConfigSchema = Type.Object(
  {
    /** Enable Slack integration */
    enabled: Type.Boolean({ default: false }),
    /** Slack Bot User OAuth Token (xoxb-...) */
    botToken: Type.String({ default: "" }),
    /** Slack app signing secret for webhook verification */
    signingSecret: Type.String({ default: "" }),
  },
  { default: {} },
);

export type SlackIntegrationConfig = Static<
  typeof SlackIntegrationConfigSchema
>;

export const CLIProxyIntegrationConfigSchema = Type.Object(
  {
    /** Internal URL of the CLIProxy service (K8s service URL) */
    url: Type.String({ default: "" }),
    /** API key for authenticating to the CLIProxy (Bearer token) */
    apiKey: Type.String({ default: "" }),
    /** Management API secret key for programmatic key management */
    managementKey: Type.String({ default: "" }),
  },
  { default: {} },
);

export type CLIProxyIntegrationConfig = Static<
  typeof CLIProxyIntegrationConfigSchema
>;

export const IntegrationsConfigSchema = Type.Object(
  {
    /** Slack bot integration */
    slack: SlackIntegrationConfigSchema,
    /** CLIProxy AI model proxy integration */
    cliproxy: CLIProxyIntegrationConfigSchema,
  },
  { default: {} },
);

export type IntegrationsConfig = Static<typeof IntegrationsConfigSchema>;

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

export const AtelierConfigSchema = Type.Object({
  domain: DomainConfigSchema,
  auth: AuthConfigSchema,
  server: ServerConfigSchema,
  kubernetes: KubernetesConfigSchema,
  sandbox: SandboxDefaultsSchema,
  ports: PortsConfigSchema,
  integrations: IntegrationsConfigSchema,
});

export type AtelierConfig = Static<typeof AtelierConfigSchema>;

// ---------------------------------------------------------------------------
// Environment variable → config path mapping
// ---------------------------------------------------------------------------

export const ENV_VAR_MAPPING = {
  ATELIER_BASE_DOMAIN: "domain.baseDomain",
  ATELIER_DASHBOARD_DOMAIN: "domain.dashboard",

  ATELIER_TLS_EMAIL: "domain.tls.email",
  ATELIER_TLS_CERT_PATH: "domain.tls.certPath",
  ATELIER_TLS_KEY_PATH: "domain.tls.keyPath",
  ATELIER_SSH_PROXY_PORT: "domain.ssh.port",
  ATELIER_SSH_PROXY_HOSTNAME: "domain.ssh.hostname",

  ATELIER_GITHUB_CLIENT_ID: "auth.github.clientId",
  ATELIER_GITHUB_CLIENT_SECRET: "auth.github.clientSecret",
  ATELIER_JWT_SECRET: "auth.jwtSecret",
  ATELIER_AUTH_ALLOWED_ORG: "auth.allowedOrg",
  ATELIER_AUTH_ALLOWED_USERS: "auth.allowedUsers",

  ATELIER_SERVER_MODE: "server.mode",
  ATELIER_SERVER_PORT: "server.port",
  ATELIER_SERVER_HOST: "server.host",
  ATELIER_MAX_SANDBOXES: "server.maxSandboxes",
  ATELIER_MAX_ACTIVE_TASKS: "server.maxActiveTasks",
  ATELIER_MCP_TOKEN: "server.mcpToken",

  ATELIER_K8S_NAMESPACE: "kubernetes.namespace",
  ATELIER_K8S_SYSTEM_NAMESPACE: "kubernetes.systemNamespace",
  ATELIER_K8S_KUBECONFIG: "kubernetes.kubeconfig",
  ATELIER_K8S_RUNTIME_CLASS: "kubernetes.runtimeClass",
  ATELIER_K8S_REGISTRY_URL: "kubernetes.registryUrl",
  ATELIER_K8S_VERDACCIO_URL: "kubernetes.verdaccioUrl",
  ATELIER_K8S_STORAGE_CLASS: "kubernetes.storageClass",
  ATELIER_K8S_VOLUME_SNAPSHOT_CLASS: "kubernetes.volumeSnapshotClass",
  ATELIER_K8S_DEFAULT_VOLUME_SIZE: "kubernetes.defaultVolumeSize",
  ATELIER_K8S_INGRESS_CLASS: "kubernetes.ingressClassName",

  ATELIER_IMAGES_DIR: "sandbox.imagesDirectory",
  ATELIER_DEFAULT_IMAGE: "sandbox.defaultImage",
  ATELIER_GIT_EMAIL: "sandbox.git.email",
  ATELIER_GIT_NAME: "sandbox.git.name",

  ATELIER_VSCODE_PORT: "ports.vscode",
  ATELIER_OPENCODE_PORT: "ports.opencode",
  ATELIER_BROWSER_PORT: "ports.browser",
  ATELIER_TERMINAL_PORT: "ports.terminal",
  ATELIER_AGENT_PORT: "ports.agent",
  ATELIER_VERDACCIO_PORT: "ports.verdaccio",

  ATELIER_SLACK_ENABLED: "integrations.slack.enabled",
  ATELIER_SLACK_BOT_TOKEN: "integrations.slack.botToken",
  ATELIER_SLACK_SIGNING_SECRET: "integrations.slack.signingSecret",

  ATELIER_CLIPROXY_URL: "integrations.cliproxy.url",
  ATELIER_CLIPROXY_API_KEY: "integrations.cliproxy.apiKey",
  ATELIER_CLIPROXY_MANAGEMENT_KEY: "integrations.cliproxy.managementKey",
} as const;

export type EnvVarName = keyof typeof ENV_VAR_MAPPING;
