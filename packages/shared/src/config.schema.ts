/**
 * Unified configuration schema for Atelier.
 * Configuration priority: ENV vars > config file > defaults
 *
 * Sections:
 *   domain   — Where this runs (base domain, SSH)
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
    /** The TCP port the in-server ssh2 gateway binds (production mode). It
     * authenticates the dev against the control SSH keys and dials `pod:22`
     * as `upstreamUser`. */
    listenPort: Type.Number({ default: 2222 }),
    /** The upstream user the SSH gateway logs into the pod as. */
    upstreamUser: Type.String({ default: "dev" }),
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
    /** Kata Containers runtime class name: the runtime-rs custom runtime from
     * infra/k8s/kata-atelier-values.yaml (guest RAM == pod memory limit) */
    runtimeClass: Type.String({ default: "kata-atelier-clh-rs" }),
    /** Ingress class name for dynamically created ingresses (e.g., traefik, nginx) */
    ingressClassName: Type.String({ default: "" }),
    /**
     * cert-manager ClusterIssuer used to mint a per-host TLS cert for each
     * dynamically created tool ingress (via HTTP-01). Empty string disables
     * TLS on tool ingresses (served over the ingress controller default).
     */
    toolIngressClusterIssuer: Type.String({ default: "" }),
    /**
     * OCI registry hostname (`host[:port]`, no scheme) for sandbox and
     * prebuild images. Empty (the default) means "no external registry":
     * images are built into and run straight from the local Docker daemon
     * (local mode). A Kubernetes deployment sets
     * this to its in-cluster registry (e.g. the bundled Zot,
     * `<release>-zot.<ns>.svc:5000`) via Helm / the mounted config file.
     */
    registryUrl: Type.String({
      default: "",
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
  },
  { default: {} },
);

export type KubernetesConfig = Static<typeof KubernetesConfigSchema>;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export const RuntimeModeSchema = Type.Union(
  [
    // Real cluster runtime + GitHub OAuth + secure cookies.
    Type.Literal("production"),
    // Real runtime (typically the Docker backend) but auth is bypassed and
    // cluster-only infra (the SSH gateway) is skipped. The single-user
    // laptop path and the dev loop (`bun run --filter @atelier/server dev`):
    // sandboxes are real containers, no GitHub OAuth app needed.
    Type.Literal("local"),
  ],
  { default: "production" },
);

export type RuntimeMode = Static<typeof RuntimeModeSchema>;

export const ServerConfigSchema = Type.Object(
  {
    /** Runtime mode: production (real VMs, the default) or local (real
     * runtime, bypassed auth — the single-user laptop/dev path). */
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
    /**
     * In-pod agent image the base seeds bake in via `COPY --from` (the
     * `AGENT_IMAGE` build-arg). Defaults to the prebuilt public GHCR image so
     * a fresh operator never has to build the Rust agent first; override to a
     * private/mirrored ref for air-gapped clusters that can't reach GHCR.
     */
    agentImage: Type.String({
      default: "ghcr.io/frak-id/sandbox-agent:latest",
    }),
    /**
     * vCPUs a sandbox gets when its create request omits `resources.vcpus`
     * (MCP agents, API callers that don't care).
     */
    defaultVcpus: Type.Number({ default: 2, minimum: 1 }),
    /**
     * Guest RAM (MB) a sandbox gets when its create request omits
     * `resources.memoryMb`. Under runtime-rs this is the whole guest RAM.
     */
    defaultMemoryMb: Type.Number({ default: 4096, minimum: 256 }),
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
// Base images (dev-base, dev-cloud, dev-rust, ...) are server-embedded seed
// build contexts (`apps/server/src/runtime/registry/seeds/`), plus any
// externally-registered ref (GHCR etc). This section configures HOW the
// server builds a seed when asked to (`ImageBuilderService` /
// `POST /v1/images`):
//
//   - docker:   shells out to a `docker` daemon (local socket, or a remote
//               `tcp://` one via `dockerHost`/`DOCKER_HOST`). Default — what
//               local mode uses to build seeds into the host daemon.
//   - buildkit: a one-shot K8s Job with the build context mounted from a
//               ConfigMap, running a `buildctl` client that dispatches to
//               the BuildKit daemon at `endpoint` (required).
// ---------------------------------------------------------------------------

export const ImageBuilderKindSchema = Type.Union([
  Type.Literal("docker"),
  Type.Literal("buildkit"),
]);

export type ImageBuilderKind = Static<typeof ImageBuilderKindSchema>;

export const ImageBuilderTlsConfigSchema = Type.Object(
  {
    /**
     * Name of a K8s Secret (in the sandbox namespace, where build Jobs run)
     * containing the client cert and trusted CA bundle. Expected keys:
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
    /**
     * Which builder strategy to use. `docker` is the local-mode daemon
     * backend and the schema default; Kubernetes deployments set `buildkit`
     * plus an `endpoint` (see `infra/k8s/30-config.yaml`).
     */
    kind: Type.Union([Type.Literal("docker"), Type.Literal("buildkit")], {
      default: "docker",
    }),
    /**
     * Override the builder image. buildkit defaults to the pinned
     * moby/buildkit `buildctl` client image; unused by docker (the daemon
     * itself does the build).
     */
    image: Type.String({ default: "" }),
    /**
     * Address of the BuildKit daemon (e.g. tcp://buildkitd.buildkit.svc:1234).
     * Required when kind=buildkit; ignored by docker.
     */
    endpoint: Type.String({ default: "" }),
    /**
     * Docker daemon URL (e.g. tcp://docker-host:2375) for kind=docker.
     * Empty string inherits the process's own `DOCKER_HOST` / default local
     * socket — the common case when the server runs beside (or as) the
     * build host. Ignored for other kinds.
     */
    dockerHost: Type.String({ default: "" }),
    /**
     * Target build platform, shared by every backend (docker `--platform`,
     * buildkit `--opt platform`). Empty (the
     * default) builds for the daemon's native architecture — so local mode
     * on an arm64 Mac builds arm64 with no emulation. Pin it (e.g.
     * linux/amd64) for a cluster whose nodes differ from the build host
     * (note the seed Dockerfiles' own amd64-pinned asset downloads must also
     * be arch-aware for a fully arm base image).
     */
    platform: Type.String({ default: "" }),
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
// Runtime backend
// ---------------------------------------------------------------------------

export const RuntimeConfigSchema = Type.Object(
  {
    /**
     * Which `SandboxBackend` orchestrates sandbox compute + network:
     *   - `kubernetes`: Pod/Service/Ingress/PVC on a cluster (default). Its
     *     `kubernetes.*` config sub-tree applies.
     *   - `docker`: `docker run` the agent locally with published ports and a
     *     Docker volume (local mode).
     */
    backend: Type.Union([Type.Literal("kubernetes"), Type.Literal("docker")], {
      default: "kubernetes",
    }),
  },
  { default: {} },
);

export type RuntimeConfig = Static<typeof RuntimeConfigSchema>;

// ---------------------------------------------------------------------------
// Jobs — the durable, observable long-op queue (JobService).
// ---------------------------------------------------------------------------

export const JobsConfigSchema = Type.Object(
  {
    /**
     * How many *pooled* jobs (prebuild bake, toolset build/capture — the
     * expensive throwaway-pod ops) may run at once. Extra dispatches wait in
     * the queue and start as slots free up. Sandbox lifecycle jobs
     * (create/pause/resume/…) are tracked for visibility but bypass this
     * limit (they must not queue behind builds, and already serialize per
     * sandbox in the runtime).
     */
    concurrency: Type.Number({ default: 4, minimum: 1 }),
  },
  { default: {} },
);

export type JobsConfig = Static<typeof JobsConfigSchema>;

// ---------------------------------------------------------------------------
// Root config
// ---------------------------------------------------------------------------

export const AtelierConfigSchema = Type.Object({
  domain: DomainConfigSchema,
  auth: AuthConfigSchema,
  server: ServerConfigSchema,
  runtime: RuntimeConfigSchema,
  jobs: JobsConfigSchema,
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
  ATELIER_SSH_LISTEN_PORT: "domain.ssh.listenPort",
  ATELIER_SSH_UPSTREAM_USER: "domain.ssh.upstreamUser",
  ATELIER_RUNTIME_BACKEND: "runtime.backend",
  ATELIER_JOBS_CONCURRENCY: "jobs.concurrency",

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
  ATELIER_K8S_STORAGE_CLASS: "kubernetes.storageClass",
  ATELIER_K8S_VOLUME_SNAPSHOT_CLASS: "kubernetes.volumeSnapshotClass",
  ATELIER_K8S_DEFAULT_VOLUME_SIZE: "kubernetes.defaultVolumeSize",
  ATELIER_K8S_INGRESS_CLASS: "kubernetes.ingressClassName",

  ATELIER_DEFAULT_IMAGE: "sandbox.defaultImage",
  ATELIER_AGENT_IMAGE: "sandbox.agentImage",
  ATELIER_DEFAULT_VCPUS: "sandbox.defaultVcpus",
  ATELIER_DEFAULT_MEMORY_MB: "sandbox.defaultMemoryMb",

  ATELIER_TERMINAL_PORT: "ports.terminal",
  ATELIER_AGENT_PORT: "ports.agent",

  ATELIER_IMAGE_BUILDER_KIND: "imageBuilder.kind",
  ATELIER_IMAGE_BUILDER_IMAGE: "imageBuilder.image",
  ATELIER_IMAGE_BUILDER_ENDPOINT: "imageBuilder.endpoint",
  ATELIER_IMAGE_BUILDER_DOCKER_HOST: "imageBuilder.dockerHost",
  ATELIER_IMAGE_BUILDER_PLATFORM: "imageBuilder.platform",
  ATELIER_IMAGE_BUILDER_CACHE_REPO: "imageBuilder.cacheRepo",
  ATELIER_IMAGE_BUILDER_INSECURE_REGISTRY: "imageBuilder.insecureRegistry",
  ATELIER_IMAGE_BUILDER_TLS_SECRET_NAME: "imageBuilder.tls.secretName",
  ATELIER_IMAGE_BUILDER_TLS_SERVER_NAME: "imageBuilder.tls.serverName",
} as const;

export type EnvVarName = keyof typeof ENV_VAR_MAPPING;
