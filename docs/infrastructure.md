# Infrastructure

## Configuration

The server uses a unified configuration system. Values can be set via:

1. **Environment variables** (highest priority)
2. **Config file** (`/etc/atelier/sandbox.config.json` or `ATELIER_CONFIG` env var)
3. **Defaults** (fallback)

See `packages/shared/schemas/sandbox.config.full-example.json` and
`packages/shared/src/config.schema.ts` for all available options, and
[Advanced Configuration](advanced-configuration.md) for the full reference.

### Key Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ATELIER_CONFIG` | Override config file path | `/etc/atelier/sandbox.config.json` |
| `ATELIER_BASE_DOMAIN` | Base domain (e.g. `example.com`) | `localhost` |
| `ATELIER_DASHBOARD_DOMAIN` | Console domain (empty = derived from base domain) | (derived) |
| `ATELIER_TLS_EMAIL` | TLS email for ACME / Let's Encrypt | (required for ACME) |
| `ATELIER_TLS_CERT_PATH` | Path to TLS certificate | (optional) |
| `ATELIER_TLS_KEY_PATH` | Path to TLS private key | (optional) |
| `ATELIER_GITHUB_CLIENT_ID` | GitHub OAuth client ID | (required for production) |
| `ATELIER_GITHUB_CLIENT_SECRET` | GitHub OAuth client secret | (required for production) |
| `ATELIER_JWT_SECRET` | JWT signing secret | (required for production) |
| `SANDBOX_SECRETS_KEY` | Encrypts saved-spec/workspace secrets at rest | (required for production) |
| `ATELIER_AUTH_ALLOWED_ORG` | Allowed GitHub organization | (optional) |
| `ATELIER_AUTH_ALLOWED_USERS` | Allowed GitHub usernames (comma-separated) | (optional) |
| `ATELIER_SERVER_MODE` | Runtime mode (`production` or `mock`) | (required; `mock` for local dev, `production` on server) |
| `ATELIER_SERVER_PORT` | Server API port | `4000` |
| `ATELIER_SERVER_HOST` | Server API bind host | `0.0.0.0` |
| `ATELIER_MCP_TOKEN` | Bearer token enabling the MCP server (empty = disabled) | (optional) |

### Console Runtime Config

The console is a static SPA — it does not fetch runtime config from the
server. `VITE_API_BASE` is a **build-time** env var (empty = same-origin,
which is how production runs: server + console share one pod/ingress). See
`apps/console/src/lib/api-base.ts`.

## Domains

Domains are configurable. Default pattern:

| Service | URL Pattern |
|---------|-------------|
| Console | `{domain.dashboard}` (empty = `sandbox.{baseDomain}`) |
| VSCode | `sandbox-{id}.{baseDomain}` |
| OpenCode | `opencode-{id}.{baseDomain}` |
| Browser | `browser-{id}.{baseDomain}` |
| Dev | `dev-{name}-{id}.{baseDomain}` |

## Pod Communication

The agent runs inside each sandbox pod, listening on TCP port 9998 (config +
process API), 9997 (attach bridge: stdio/PTY relay), and 7681 (ad-hoc
terminal WS relay). The server reaches the agent via the pod IP obtained
from the K8s API (`pod.status.podIP`).

## npm Registry

Atelier does not bundle an npm registry. Set `kubernetes.npmRegistryUrl` to
an external proxy (Verdaccio, Nexus, Artifactory, …) and the server injects
`npmrc`/`bunfig`/`yarnrc` into every sandbox so npm/bun/yarn use it. Leave it
empty to use the public npm registry.

## Network Architecture

```
Internet → Traefik (:443, TLS) → K8s Ingress → Service → Pod:port
```

- Sandbox pods get IPs from K8s CNI (10.42.x.x range)
- K8s Services provide stable endpoints for each sandbox
- Ingress resources handle host-based routing (`sandbox-{id}.{domain}`, etc.)

## Storage (TopoLVM CSI)

PVC snapshots via TopoLVM for instant CoW clones:

```
TopoLVM Thin Pool (LVM VG on node)
├── PVCs (per sandbox)          # Workspace data (cloned from VolumeSnapshot)
├── VolumeSnapshots             # Per-saved-spec prebuilds
└── Temp PVCs                   # Created during prebuild, deleted after snapshot
```

### K8s Resources

| Resource | Namespace | Purpose |
|----------|-----------|---------|
| Sandbox Pod + Service + Ingress | `kubernetes.namespace` (app config; e.g. `atelier-v2-sandboxes`) | Per-sandbox compute + routing |
| Workspace PVC | Sandbox namespace | Per-sandbox data volume (from VolumeSnapshot); `/data/upper` + `/data/work` back the `/home/dev` overlay |
| VolumeSnapshot | Sandbox namespace | Prebuild snapshots (CoW clones for new PVCs) |
| Server + Console Deployment + PVC | App system namespace (`infra/k8s/v2`, e.g. `atelier-v2-system`) | API + SPA + SQLite database |
| Zot Deployment + PVC | Infra chart namespace (`charts/atelier`) | OCI registry for base images + toolset artifacts |

## Deployment

Two independent pieces:

1. **Shared cluster infra** — the `charts/atelier` Helm chart (Zot, CLIProxy,
   sshpiper, cert-manager issuers, Kata RuntimeClass, snapshot class). From a
   dev machine:

   ```bash
   VALUES_FILE=./values.production.yaml ./scripts/deploy-k8s.sh
   ```

2. **The server + console app** — plain manifests under `infra/k8s/v2/`,
   applied directly with `kubectl`/`helm` for the Kata custom runtime. See
   [`infra/k8s/v2/README.md`](../infra/k8s/v2/README.md) for the full apply
   sequence and how to rebuild images in-cluster with BuildKit.

## Resource Cleanup

On sandbox destruction (K8s label-based):
1. Delete all resources with label `atelier.dev/sandbox={id}` (pods, services, configmaps, PVCs, ingresses, volumesnapshots)
2. Explicit pod delete as fallback (idempotent, catches 404)
3. Database record delete

K8s garbage collection handles orphaned resources automatically.
