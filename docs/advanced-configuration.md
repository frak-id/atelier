# Advanced Configuration

Atelier's deploy topology is split in two:

- **`charts/atelier`** — the shared cluster infra Helm chart: Zot (OCI
  registry), CLIProxyAPI, sshpiper, cert-manager issuers + wildcard certs,
  the Kata `RuntimeClass`, and the prebuild `VolumeSnapshotClass`. It does
  **not** deploy the server or console app.
- **`infra/k8s/v2`** — plain Kubernetes manifests for the server + console
  app itself (Deployment, Service, Ingress, config ConfigMap, secrets, PVC,
  RBAC). See [`infra/k8s/v2/README.md`](../infra/k8s/v2/README.md) for the
  full apply sequence.

This page documents the infra chart's values (`charts/atelier/values.yaml`).
For app-level settings (domain, auth, ports, sandbox defaults, MCP token,
CLIProxy wiring), edit `infra/k8s/v2/30-config.yaml` (non-secret config,
mounted as `/etc/atelier/sandbox.config.json`) and the `atelier-v2-secrets`
Secret (credentials) — see the schema reference below.

Apply infra chart changes with:

```bash
helm upgrade atelier ./charts/atelier \
  --namespace atelier-system \
  --values values.production.yaml
```

## App configuration (`infra/k8s/v2/30-config.yaml` + secrets)

The server reads a layered config: env vars > the mounted
`sandbox.config.json` > built-in defaults. The full schema lives in
`packages/shared/src/config.schema.ts`; the generated JSON Schema is at
`packages/shared/schemas/atelier.config.schema.json`.

```jsonc
{
  "domain": {
    "baseDomain": "example.com",     // REQUIRED — all services hang off this
    "dashboard": "atelier.example.com",
    "tls": { "email": "admin@example.com" },
    "ssh": { "port": 2222, "hostname": "ssh.example.com" }
  },
  "auth": {
    "allowedOrg": "my-github-org"    // optional GitHub org restriction
  },
  "server": {
    "mode": "production",
    "port": 4000,
    "host": "0.0.0.0",
    "maxSandboxes": 20,
    "maxActiveTasks": 10
  },
  "kubernetes": {
    "namespace": "atelier-v2-sandboxes",
    "systemNamespace": "atelier-v2-system",
    "runtimeClass": "kata-atelier-clh",
    "ingressClassName": "traefik",
    "toolIngressClusterIssuer": "letsencrypt-prod",
    "registryUrl": "zot.zot.svc:5000",
    "npmRegistryUrl": "",
    "storageClass": "topolvm-thin",
    "volumeSnapshotClass": "atelier-snapshots",
    "defaultVolumeSize": "20Gi"
  },
  "sandbox": {
    "defaultImage": "dev-base-v2",
    "git": { "email": "sandbox@atelier.dev", "name": "Sandbox User" }
  }
}
```

Secrets (GitHub OAuth, JWT, secrets-at-rest key, MCP token, CLIProxy API key)
are injected via env from the `atelier-v2-secrets` Secret and override the
matching config fields — see `infra/k8s/v2/README.md` for the exact
`kubectl create secret` command.

Resulting URL patterns:

| Service | URL |
|---------|-----|
| Console | `{domain.dashboard}` |
| VS Code | `sandbox-{id}.{baseDomain}` |
| OpenCode | `opencode-{id}.{baseDomain}` |
| Browser (KasmVNC) | `browser-{id}.{baseDomain}` |
| Dev command | `dev-{name}-{id}.{baseDomain}` |

### Key environment variables (server)

Set directly on the Deployment (`infra/k8s/v2/50-deployment.yaml`); these
override the config file.

| Variable | Description |
|----------|-------------|
| `ATELIER_SERVER_MODE` | `production` or `mock` (local dev, no K8s/KVM) |
| `ATELIER_CONFIG` | Path to the mounted config JSON (default `/etc/atelier/sandbox.config.json`) |
| `ATELIER_GITHUB_CLIENT_ID` / `_SECRET` | GitHub OAuth credentials |
| `ATELIER_JWT_SECRET` | JWT signing secret |
| `SANDBOX_SECRETS_KEY` | Encrypts saved-spec/workspace secrets at rest |
| `ATELIER_MCP_TOKEN` | Bearer token enabling the MCP server (empty = disabled) |
| `ATELIER_CLIPROXY_URL` / `_API_KEY` | CLIProxy model provider baked into sandbox `opencode.json` at spec enrichment |

The full `ATELIER_*` → config-path mapping is `ENV_VAR_MAPPING` in
`packages/shared/src/config.schema.ts`.

### MCP server for AI agents

Set `ATELIER_MCP_TOKEN` (Secret key) to let external AI agents orchestrate
sandboxes via the Model Context Protocol (`/mcp`). Agents authenticate with
`Authorization: Bearer <token>`.

## Base images (dev-base, dev-cloud)

Base images are **not** built by the server at runtime — there is no
build-from-UI feature in v2. They're built in-cluster with BuildKit
(`buildctl`) against a shared `buildkitd` and pushed to Zot; see
`infra/k8s/v2/deploy.sh` and [`infra/k8s/v2/README.md`](../infra/k8s/v2/README.md#rebuild-images-in-cluster-no-local-docker).
The `imageBuilder.*` config schema (kaniko/buildkit) still exists in
`packages/shared` for a planned server-side rebuild but is currently unread.

## Infra chart values (`charts/atelier/values.yaml`)

### Ingress

```yaml
ingress:
  className: traefik             # traefik (k3s default) | nginx | …
  annotations: {}
```

### In-pod sandbox agent

```yaml
agent:
  image:
    repository: ghcr.io/frak-id/sandbox-agent
    tag: ""                      # Empty defaults to the chart appVersion
```

Not run directly — the binary is baked into base images at build time
(`/usr/local/bin/sandbox-agent`, from `apps/agent-v2`). Set `repository: ""`
to fall back to the in-registry `<registryUrl>/sandbox-agent:latest`.

### Zot (OCI Registry)

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

### CLIProxyAPI (AI model proxy)

Wraps Claude, Gemini, Codex, Qwen, etc. into OpenAI-compatible endpoints with a management UI at `/management.html`.

```yaml
cliproxy:
  enabled: true
  port: 8317
  configSeedStrategy: "seed-once"  # seed-once | hash-sync (see warning below)
  managementKey: ""                # Management UI key (auto-generated if empty)
  managerApiKey: ""                # Key the app uses to fetch models (auto-generated)
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

### sshpiper (SSH proxy)

Username-based SSH routing: `ssh sandbox-{id}@your-host -p 2222`.

```yaml
sshpiper:
  enabled: true
  port: 2222          # SSH listen port inside the cluster
  nodePort: 30022     # External NodePort (0 = auto-assign)
  logLevel: "info"    # trace | debug | info | warn | error
```

To expose plain port `2222` externally, DNAT `2222 → 30022` on the host firewall, or set k3s' service node port range to include 2222.

### cert-manager Integration

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

Currently **only Cloudflare DNS-01** is supported for the wildcard certificate.

### Kata Containers runtime class

```yaml
kata:
  createRuntimeClass: false    # kata-deploy usually creates it; set true to manage in-chart
  handler: kata-clh
```

Prerequisites: kata-deploy must be installed in the cluster.

### Snapshot support (for prebuilds)

Prebuilds use CSI VolumeSnapshots to clone workspace filesystems instantly.
Without a CSI driver + snapshot controller, prebuilds are automatically
disabled at startup — everything else still works.

```yaml
snapshots:
  createSnapshotClass: false   # Let the chart create a VolumeSnapshotClass
  driver: ""                   # CSI driver name, e.g. "topolvm.io" or "ebs.csi.aws.com"
  deletionPolicy: Delete       # Delete | Retain
```

### Global / RBAC

```yaml
global:
  imagePullSecrets: []           # e.g. [{ name: regcred }]

serviceAccount:
  create: true
  name: ""
  annotations: {}

rbac:
  create: true
```

## Recipes

### Use an external registry instead of Zot

```yaml
# charts/atelier/values.yaml
zot:
  enabled: false
  externalUrl: "registry.internal:5000"
```

Then point the app's `kubernetes.registryUrl` (in `infra/k8s/v2/30-config.yaml`) at the same host:port.

### Enable prebuilds with TopoLVM

```yaml
# charts/atelier/values.yaml
snapshots:
  createSnapshotClass: true
  driver: topolvm.io
```

```jsonc
// infra/k8s/v2/30-config.yaml
{
  "kubernetes": {
    "storageClass": "topolvm-provisioner",
    "volumeSnapshotClass": "atelier-snapshots"
  }
}
```
