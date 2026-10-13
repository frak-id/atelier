# Advanced Configuration

Atelier deploys only the server + console app: plain Kubernetes manifests
under **`infra/k8s`** (Deployment, Service, Ingress, config ConfigMap,
secrets, PVC, RBAC). See [`infra/k8s/README.md`](../infra/k8s/README.md)
for the full apply sequence.

Cluster infra (Kata runtime, cert-manager ClusterIssuer, TopoLVM + snapshot
class, OCI registry, BuildKit, CLIProxy) is installed separately and
referenced by name from the app config; see the [Setup Guide](setup.md#prerequisites).

For app-level settings (domain, auth, ports, sandbox defaults, MCP token,
CLIProxy wiring), edit `infra/k8s/30-config.yaml` (non-secret config,
mounted as `/etc/atelier/sandbox.config.json`) and the `atelier-v2-secrets`
Secret (credentials) — see the schema reference below.

## App configuration (`infra/k8s/30-config.yaml` + secrets)

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
    "runtimeClass": "kata-atelier-clh-rs",
    "ingressClassName": "traefik",
    "toolIngressClusterIssuer": "letsencrypt-prod",
    "registryUrl": "zot.zot.svc:5000",
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
matching config fields — see `infra/k8s/README.md` for the exact
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

Set directly on the Deployment (`infra/k8s/50-deployment.yaml`); these
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

Production base images are typically built out-of-band with the cluster's
BuildKit (`buildctl`) against a shared `buildkitd` and pushed to Zot; see
`infra/k8s/deploy.sh` and [`infra/k8s/README.md`](../infra/k8s/README.md#rebuild-images-in-cluster-no-local-docker).
The server also builds images itself (`POST /v1/images`,
`ImageBuilderService`, triggered from the console or CLI) using the
`imageBuilder.*` config. `imageBuilder.kind=buildkit` with no `endpoint` (the
default) runs BuildKit daemonless in a one-shot Job, so an in-cluster build
needs no pre-existing daemon; `kind=docker` shells out to a Docker daemon
(what `atelier local up` uses).

## Recipes

### Use a different OCI registry

Point the app's `kubernetes.registryUrl` (in `infra/k8s/30-config.yaml`) at
the registry's `host:port` (no scheme). A plain-HTTP registry must also be a
mirror in the node's `/etc/rancher/k3s/registries.yaml`.

### Pause idle sandboxes

The server pauses running sandboxes nobody uses (proposal:
[sandbox-idle-autopause.md](proposals/sandbox-idle-autopause.md)). The rules
are `sandbox.idle.*` keys of the server config plane: edit them on the
console's *Server configuration* page, or lock them with their env var.

| Key | Env var | Default |
|-----|---------|---------|
| `sandbox.idle.mode` (`off`/`observe`/`enforce`) | `ATELIER_IDLE_MODE` | `observe` |
| `sandbox.idle.minutes` | `ATELIER_IDLE_MINUTES` | `120` |
| `sandbox.idle.network` | `ATELIER_IDLE_NETWORK` | `true` |
| `sandbox.idle.networkMinBytesPerMinute` | `ATELIER_IDLE_NETWORK_MIN_BYTES` | `65536` |
| `sandbox.idle.files` | `ATELIER_IDLE_FILES` | `true` |
| `sandbox.idle.cpu` | `ATELIER_IDLE_CPU` | `false` |
| `sandbox.idle.cpuMinMillicores` | `ATELIER_IDLE_CPU_MIN_MILLICORES` | `250` |
| `sandbox.idle.maxKeepAwakeHours` | `ATELIER_IDLE_MAX_KEEP_AWAKE_HOURS` | `24` |

Start in `observe`: every sandbox page shows when it *would* be paused and
its traffic per minute, so the byte threshold can be checked against real
idle tabs before switching to `enforce`. Network and file signals need a
sandbox image whose agent serves `GET /activity`; older ones are never
paused while those signals count. Network is measured per interface
(received + sent, minus the server's own traffic to the agent); file writes
count under `/home/dev` except build output, dependencies and the hidden
tool state at the top of the home.

### Enable prebuilds with TopoLVM

Create a `VolumeSnapshotClass` for the `topolvm.io` driver (see
[Setup → Storage and snapshots](setup.md#5-storage-and-snapshots-optional--required-for-prebuilds)),
then reference it and a Block-capable TopoLVM StorageClass:

```jsonc
// infra/k8s/30-config.yaml
{
  "kubernetes": {
    "storageClass": "topolvm-provisioner",
    "volumeSnapshotClass": "atelier-snapshots"
  }
}
```
