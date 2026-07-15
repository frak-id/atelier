/**
 * Unified configuration schema for Atelier.
 * Configuration priority: ENV vars > config file > defaults
 *
 * Sections:
 *   domain   — Where this runs (base domain, TLS, SSH)
 *   auth     — Who can access (GitHub OAuth, JWT, ACLs)
 *   server   — Server API settings (mode, port, limits)
 *   sandbox  — Defaults for new sandboxes (image)
 */
import { type Static, Type } from "@sinclair/typebox";

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

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
    /** Path to kubeconfig file (ignored when running in-cluster) */
    kubeconfig: Type.String({ default: "/etc/rancher/k3s/k3s.yaml" }),
    /** Kata Containers runtime class name */
    runtimeClass: Type.String({ default: "kata-clh" }),
    /** Ingress class name for dynamically created ingresses (e.g., traefik, nginx) */
    ingressClassName: Type.String({ default: "" }),
    /**
     * cert-manager ClusterIssuer used to mint a per-host TLS cert for each
     * dynamically created tool ingress (via HTTP-01). Empty string disables
     * TLS on tool ingresses (served over the ingress controller default).
     */
    toolIngressClusterIssuer: Type.String({ default: "" }),
    /** OCI registry hostname for sandbox and prebuild images (Zot) */
    registryUrl: Type.String({
      default: "zot.atelier-system.svc:5000",
    }),
    /**
     * Optional npm registry URL injected into every sandbox (e.g. a private
     * Verdaccio/Nexus/Artifactory proxy). Empty string disables injection and
     * sandboxes fall back to the public npm registry.
     */
    npmRegistryUrl: Type.String({ default: "" }),
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
    /** Server API port */
    port: Type.Number({ default: 4000 }),
    /** Server API bind host */
    host: Type.String({ default: "0.0.0.0" }),
  },
  { default: {} },
);

export type ServerConfig = Static<typeof ServerConfigSchema>;

// ---------------------------------------------------------------------------
// Sandbox defaults
// ---------------------------------------------------------------------------

export const SandboxDefaultsSchema = Type.Object(
  {
    /** Default image for new sandboxes */
    defaultImage: Type.String({ default: "dev-base" }),
  },
  { default: {} },
);

export type SandboxDefaults = Static<typeof SandboxDefaultsSchema>;

// ---------------------------------------------------------------------------
// Ports — infra-level service ports.
//
// Only ports the server itself needs to reach live here. Tool ports (vscode,
// browser, dev servers, opencode, …) are declared per-sandbox via `spec.ports`
// and must NOT be duplicated here — a static entry claims the port name in the
// Service dedup and silently shadows the spec's real entry.
// ---------------------------------------------------------------------------

export const PortsConfigSchema = Type.Object(
  {
    terminal: Type.Number({ default: 7681 }),
    agent: Type.Number({ default: 9998 }),
  },
  { default: {} },
);

export type PortsConfig = Static<typeof PortsConfigSchema>;

// ---------------------------------------------------------------------------
// Image Builder
//
// ROADMAP / NOT YET WIRED: reserved for the planned server-side base-image
// build. No code reads `imageBuilder.*` today; base images are currently built
// out-of-band (see scripts/deploy-k8s.sh). Kept as the config seam for when the
// server grows an in-cluster build path.
//
// Strategy for building base images (e.g. dev-base, dev-cloud) from
// Dockerfiles in `sandbox.imagesDirectory`. Two strategies are supported:
//
//   - kaniko:   spawn a K8s Job running gcr.io/kaniko-project/executor
//               with the build context mounted from a ConfigMap. Default;
//               works out of the box with no external dependencies.
//   - buildkit: spawn a tiny `buildctl` client Job that dispatches the
//               build to an existing BuildKit daemon at `endpoint`. Use
//               this when the cluster already hosts a buildkitd Pod that
//               you want to reuse.
// ---------------------------------------------------------------------------

export const ImageBuilderKindSchema = Type.Union([
  Type.Literal("kaniko"),
  Type.Literal("buildkit"),
]);

export type ImageBuilderKind = Static<typeof ImageBuilderKindSchema>;

export const ImageBuilderTlsConfigSchema = Type.Object(
  {
    /**
     * Name of a K8s Secret (in `kubernetes.systemNamespace`) containing
     * the client cert and trusted CA bundle. Expected keys:
     *   - `ca.crt`  : CA bundle used to verify the buildkitd server cert
     *   - `tls.crt` : client certificate presented to buildkitd
     *   - `tls.key` : client private key
     * Leave empty to talk plaintext to the daemon.
     */
    secretName: Type.String({ default: "" }),
    /**
     * Override the server name used for TLS hostname verification
     * (passed as `--tlsservername`). Useful when the daemon's cert
     * was issued for a different name than the endpoint hostname.
     */
    serverName: Type.String({ default: "" }),
  },
  { default: {} },
);

export type ImageBuilderTlsConfig = Static<typeof ImageBuilderTlsConfigSchema>;

export const ImageBuilderConfigSchema = Type.Object(
  {
    /** Which builder strategy to use */
    kind: Type.Union([Type.Literal("kaniko"), Type.Literal("buildkit")], {
      default: "kaniko",
    }),
    /**
     * Override the builder image. Defaults to a sensible value per kind:
     *   - kaniko:   gcr.io/kaniko-project/executor:latest
     *   - buildkit: moby/buildkit:latest (used as the buildctl client)
     */
    image: Type.String({ default: "" }),
    /**
     * Address of an existing BuildKit daemon (e.g.
     * tcp://buildkitd.buildkit.svc:1234). Required when kind=buildkit;
     * ignored otherwise.
     */
    endpoint: Type.String({ default: "" }),
    /**
     * Cache repository used by the builder. Defaults to
     * `${kubernetes.registryUrl}/cache` when empty.
     */
    cacheRepo: Type.String({ default: "" }),
    /**
     * Treat the destination/cache registry as insecure (HTTP / self-signed).
     * Defaults to true because the bundled Zot registry runs without TLS.
     */
    insecureRegistry: Type.Boolean({ default: true }),
    /**
     * Optional mTLS configuration for talking to the buildkitd daemon.
     * Only relevant when `kind="buildkit"`.
     */
    tls: ImageBuilderTlsConfigSchema,
  },
  { default: {} },
);

export type ImageBuilderConfig = Static<typeof ImageBuilderConfigSchema>;

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
  imageBuilder: ImageBuilderConfigSchema,
});

export type AtelierConfig = Static<typeof AtelierConfigSchema>;

// ---------------------------------------------------------------------------
// Environment variable → config path mapping
// ---------------------------------------------------------------------------

export const ENV_VAR_MAPPING = {
  ATELIER_BASE_DOMAIN: "domain.baseDomain",
  ATELIER_DASHBOARD_DOMAIN: "domain.dashboard",

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

  ATELIER_K8S_NAMESPACE: "kubernetes.namespace",
  ATELIER_K8S_KUBECONFIG: "kubernetes.kubeconfig",
  ATELIER_K8S_RUNTIME_CLASS: "kubernetes.runtimeClass",
  ATELIER_K8S_TOOL_INGRESS_ISSUER: "kubernetes.toolIngressClusterIssuer",
  ATELIER_K8S_REGISTRY_URL: "kubernetes.registryUrl",
  ATELIER_NPM_REGISTRY_URL: "kubernetes.npmRegistryUrl",
  ATELIER_K8S_STORAGE_CLASS: "kubernetes.storageClass",
  ATELIER_K8S_VOLUME_SNAPSHOT_CLASS: "kubernetes.volumeSnapshotClass",
  ATELIER_K8S_DEFAULT_VOLUME_SIZE: "kubernetes.defaultVolumeSize",
  ATELIER_K8S_INGRESS_CLASS: "kubernetes.ingressClassName",

  ATELIER_DEFAULT_IMAGE: "sandbox.defaultImage",

  ATELIER_TERMINAL_PORT: "ports.terminal",
  ATELIER_AGENT_PORT: "ports.agent",

  ATELIER_IMAGE_BUILDER_KIND: "imageBuilder.kind",
  ATELIER_IMAGE_BUILDER_IMAGE: "imageBuilder.image",
  ATELIER_IMAGE_BUILDER_ENDPOINT: "imageBuilder.endpoint",
  ATELIER_IMAGE_BUILDER_CACHE_REPO: "imageBuilder.cacheRepo",
  ATELIER_IMAGE_BUILDER_INSECURE_REGISTRY: "imageBuilder.insecureRegistry",
  ATELIER_IMAGE_BUILDER_TLS_SECRET_NAME: "imageBuilder.tls.secretName",
  ATELIER_IMAGE_BUILDER_TLS_SERVER_NAME: "imageBuilder.tls.serverName",
} as const;

export type EnvVarName = keyof typeof ENV_VAR_MAPPING;
