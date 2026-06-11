# Advanced Configuration

Complete reference for every option in the Atelier Helm chart (`charts/atelier/values.yaml`) plus runtime environment variables.

Apply changes with:

```bash
helm upgrade atelier ./charts/atelier \
  --namespace atelier-system \
  --values values.production.yaml
```

## Domain & TLS

```yaml
domain:
  baseDomain: ""        # REQUIRED — e.g. "example.com". All services hang off this.
  dashboard: ""         # Dashboard domain. Empty = "sandbox.{baseDomain}"
  tls:
    email: ""           # ACME contact email (required when certManager.enabled)
```

Resulting URL patterns:

| Service | URL |
|---------|-----|
| Dashboard | `sandbox.{baseDomain}` |
| VS Code | `sandbox-{id}.{baseDomain}` |
| OpenCode | `opencode-{id}.{baseDomain}` |
| Browser (KasmVNC) | `browser-{id}.{baseDomain}` |
| Dev command | `dev-{name}-{id}.{baseDomain}` |

## Authentication

```yaml
auth:
  github:
    clientId: ""        # GitHub OAuth App client ID
    clientSecret: ""    # GitHub OAuth App client secret
  jwtSecret: ""         # JWT signing secret — auto-generated if empty
  allowedOrg: ""        # Restrict login to members of this GitHub org
  allowedUsers: []      # Or restrict to explicit GitHub usernames
  existingSecret: ""    # Use a pre-created K8s Secret instead of values
```

When using `existingSecret`, the Secret must contain `ATELIER_GITHUB_CLIENT_ID`, `ATELIER_GITHUB_CLIENT_SECRET`, `ATELIER_JWT_SECRET`, `SANDBOX_SECRETS_KEY`, and optionally `ATELIER_MCP_TOKEN`. This keeps credentials out of your values file (recommended with sealed-secrets / SOPS / external-secrets).

The GitHub OAuth App callback URL must be `https://sandbox.{baseDomain}/auth/callback`.

## Server

```yaml
server:
  port: 4000            # Manager API port
  maxSandboxes: 20      # Hard cap on concurrent sandboxes
  maxActiveTasks: 10    # Hard cap on concurrent AI tasks
  mcpToken: ""          # Bearer token enabling the MCP server (empty = disabled)
```

Setting `mcpToken` lets external AI agents orchestrate sandboxes, tasks, workspaces, and dev commands via the Model Context Protocol.

## Kubernetes & Storage

```yaml
kubernetes:
  namespace: atelier-sandboxes   # Namespace for sandbox pods (created by the chart)
  runtimeClass: kata-clh         # RuntimeClass for VM isolation
  storageClass: ""               # StorageClass for sandbox PVCs (empty = cluster default)
  volumeSnapshotClass: ""        # VolumeSnapshotClass for prebuilds (empty = cluster default)
  defaultVolumeSize: "10Gi"      # Default PVC size for new sandboxes
```

### Prebuilds / snapshots

Prebuilds require a CSI driver with snapshot support (e.g. TopoLVM) and the CSI snapshot controller. Without them, prebuilds are **automatically disabled at startup** — everything else still works.

```yaml
snapshots:
  createSnapshotClass: false   # Let the chart create a VolumeSnapshotClass
  driver: ""                   # CSI driver name, e.g. "topolvm.io" or "ebs.csi.aws.com"
  deletionPolicy: Delete       # Delete | Retain
```

### Kata runtime class

```yaml
kata:
  createRuntimeClass: false    # kata-deploy usually creates it; set true to manage in-chart
  handler: kata-clh
```

## Sandbox Defaults

```yaml
sandbox:
  defaultImage: dev-base       # Base image for new sandboxes (dev-base | dev-cloud | custom)
  git:
    email: sandbox@atelier.dev # Default git identity inside sandboxes
    name: Sandbox User

ports:                         # Internal service ports inside sandbox VMs —
  vscode: 8080                 # only change if your custom images differ
  opencode: 3000
  browser: 6080
  terminal: 7681
  agent: 9999
```

## Image Builder (base images from the dashboard)

Build and publish base images directly from the UI — no local Docker needed.

```yaml
imageBuilder:
  kind: kaniko             # kaniko (default, zero deps) | buildkit (external daemon)
  image: ""                # Builder image override (per-kind defaults apply)
  endpoint: ""             # REQUIRED when kind=buildkit, e.g. tcp://buildkitd.buildkit.svc:1234
  cacheRepo: ""            # Layer cache repo (empty = bundled Zot at {registryUrl}/cache)
  insecureRegistry: true   # Bundled Zot has no TLS; set false for an external TLS registry
  tls:                     # mTLS for BuildKit (kind=buildkit only)
    secretName: ""         # Secret with ca.crt / tls.crt / tls.key
    serverName: ""         # Optional SNI override
```

- **kaniko** — spawns a K8s Job per build; works out of the box
- **buildkit** — dispatches to a BuildKit daemon you already host; only a small `buildctl` Job runs per build

## Zot (OCI Registry)

```yaml
zot:
  enabled: true
  externalUrl: ""              # Use an existing registry instead (host:port, no scheme).
                               # Skips the bundled Zot deployment entirely.
  image:
    repository: ghcr.io/project-zot/zot-linux-amd64
    tag: "v2.1.14"
  persistence:
    size: 20Gi
    storageClass: ""
  port: 5000
```

## CLIProxyAPI (AI model proxy)

Wraps Claude, Gemini, Codex, Qwen, etc. into OpenAI-compatible endpoints with a management UI at `/management.html`.

```yaml
cliproxy:
  enabled: true
  port: 8317
  configSeedStrategy: "seed-once"  # seed-once | hash-sync (see warning below)
  managementKey: ""                # Management UI key (auto-generated if empty)
  managerApiKey: ""                # Key the manager uses to fetch models (auto-generated)
  apiKeys: []                      # Bearer tokens for proxy clients
  extraConfig: {}                  # Merged into config.yaml (provider keys, aliases, …)
  persistence:
    size: 1Gi
```

> **Warning:** with `configSeedStrategy: hash-sync`, a `helm upgrade` that changes `apiKeys`, `extraConfig`, or `port` **overwrites** any config made through the management UI. `seed-once` (default) preserves UI changes but ignores later Helm value changes.

Example `extraConfig`:

```yaml
cliproxy:
  extraConfig:
    gemini-api-key:
      - api-key: "AIzaSy..."
    proxy-url: "socks5://proxy:1080"
```

## sshpiper (SSH proxy)

Username-based SSH routing: `ssh sandbox-{id}@your-host -p 2222`.

```yaml
sshpiper:
  enabled: true
  port: 2222          # SSH listen port inside the cluster
  nodePort: 30022     # External NodePort (0 = auto-assign)
  logLevel: "info"    # trace | debug | info | warn | error
```

To expose plain port `2222` externally, DNAT `2222 → 30022` on the host firewall, or set k3s' service node port range to include 2222.

## cert-manager Integration

```yaml
certManager:
  enabled: true
  namespace: cert-manager            # Where cert-manager is installed
  createIssuer: true                 # Set false if you manage ClusterIssuers externally
  issuerName: letsencrypt-prod       # or letsencrypt-staging while testing
  server: https://acme-v02.api.letsencrypt.org/directory
  cloudflare:
    apiToken: ""                     # Chart creates the Secret when set
    apiTokenSecretRef:               # Or reference a pre-created Secret
      name: cloudflare-api-token
      key: api-token
```

Currently **only Cloudflare DNS-01** is supported for the wildcard certificate. For other DNS providers, set `certManager.enabled: false` and provide certs manually (see [Setup Guide — Manual TLS](setup.md#manual-tls)).

## Shared Binaries

A Job downloads code-server and OpenCode once into a `ReadOnlyMany` PVC mounted by every sandbox — keeping base images small and updates centralized.

```yaml
sharedBinaries:
  enabled: true
  storage: 2Gi
  image: curlimages/curl:8.17.0
  opencode:
    version: "1.16.2"
  codeServer:
    version: "4.116.0"
```

Bump the versions and `helm upgrade` to roll out new binaries.

## npm Registry Proxy

```yaml
npmRegistryUrl: ""   # e.g. "https://npm.example.com" (Verdaccio/Nexus/Artifactory)
```

When set, `npmrc`/`bunfig`/`yarnrc` are injected into every sandbox so npm, bun, and yarn use your proxy. Empty = public npm registry.

## Secrets Encryption

```yaml
secrets:
  encryptionKey: ""   # Key encrypting workspace secrets at rest (auto-generated if empty)
```

## Manager & Dashboard Tuning

```yaml
manager:
  image:
    repository: ghcr.io/frak-id/atelier-manager
    tag: ""                      # Empty = chart appVersion
  resources:
    requests: { memory: "256Mi", cpu: "100m" }
    limits:   { memory: "1Gi",   cpu: "1000m" }
  persistence:
    size: 1Gi                    # SQLite database volume
  nodeSelector: {}
  tolerations: []
  affinity: {}
  podAnnotations: {}
  podLabels: {}

dashboard:
  image:
    repository: ghcr.io/frak-id/atelier-dashboard
  resources:
    requests: { memory: "32Mi", cpu: "10m" }
    limits:   { memory: "64Mi", cpu: "100m" }

ingress:
  className: traefik             # traefik (k3s default) | nginx | …
  annotations: {}

global:
  imagePullSecrets: []           # e.g. [{ name: regcred }]

serviceAccount:
  create: true
  name: ""
  annotations: {}

rbac:
  create: true                   # ClusterRole/Role + bindings for the manager
```

## Environment Variables (manager runtime)

Helm sets these for you, but they're useful for local development and debugging. Priority: env vars > config file (`ATELIER_CONFIG`, default `/etc/atelier/sandbox.config.json`) > defaults.

| Variable | Description | Default |
|----------|-------------|---------|
| `ATELIER_SERVER_MODE` | `production` or `mock` (local dev, no K8s/KVM) | required |
| `ATELIER_BASE_DOMAIN` | Base domain | `localhost` |
| `ATELIER_DASHBOARD_DOMAIN` | Dashboard domain | derived |
| `ATELIER_TLS_EMAIL` | ACME contact email | — |
| `ATELIER_GITHUB_CLIENT_ID` / `_SECRET` | GitHub OAuth credentials | — |
| `ATELIER_JWT_SECRET` | JWT signing secret | — |
| `ATELIER_AUTH_ALLOWED_ORG` | Allowed GitHub org | — |
| `ATELIER_AUTH_ALLOWED_USERS` | Allowed usernames (comma-separated) | — |
| `ATELIER_SERVER_PORT` / `_HOST` | API bind | `4000` / `0.0.0.0` |
| `ATELIER_MAX_SANDBOXES` | Concurrent sandbox cap | `20` |

## Recipes

### Restrict access to your team

```yaml
auth:
  allowedOrg: "my-company"        # any member of the org
  # or
  allowedUsers: ["alice", "bob"]  # explicit allow-list
```

### Use an external registry instead of Zot

```yaml
zot:
  enabled: false
  externalUrl: "registry.internal:5000"
imageBuilder:
  insecureRegistry: false         # if your registry has proper TLS
```

### Enable prebuilds with TopoLVM

```yaml
kubernetes:
  storageClass: topolvm-provisioner
  volumeSnapshotClass: topolvm-snapshot
snapshots:
  createSnapshotClass: true
  driver: topolvm.io
```

### Enable the MCP server for AI agents

```yaml
server:
  mcpToken: "a-long-random-token"
```

Agents authenticate with `Authorization: Bearer <token>` and can manage sandboxes, tasks, workspaces, and dev commands programmatically.
