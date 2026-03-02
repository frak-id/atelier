# Infrastructure

## Configuration

Atelier uses a unified configuration system. Values can be set via:

1. **Environment variables** (highest priority)
2. **Config file** (`/etc/atelier/sandbox.config.json` or `ATELIER_CONFIG` env var)
3. **Defaults** (fallback)

See `packages/shared/schemas/sandbox.config.full-example.json` in the repository root for all available options.

### Key Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ATELIER_CONFIG` | Override config file path | `/etc/atelier/sandbox.config.json` |
| `ATELIER_BASE_DOMAIN` | Base domain (e.g. `example.com`) | `localhost` |
| `ATELIER_DASHBOARD_DOMAIN` | Dashboard domain (empty = derived from base domain) | (derived) |
| `ATELIER_TLS_EMAIL` | TLS email for ACME / Let's Encrypt | (required for ACME) |
| `ATELIER_TLS_CERT_PATH` | Path to TLS certificate | (optional) |
| `ATELIER_TLS_KEY_PATH` | Path to TLS private key | (optional) |
| `ATELIER_GITHUB_CLIENT_ID` | GitHub OAuth client ID | (required for production) |
| `ATELIER_GITHUB_CLIENT_SECRET` | GitHub OAuth client secret | (required for production) |
| `ATELIER_JWT_SECRET` | JWT signing secret | (required for production) |
| `ATELIER_AUTH_ALLOWED_ORG` | Allowed GitHub organization | (optional) |
| `ATELIER_AUTH_ALLOWED_USERS` | Allowed GitHub usernames (comma-separated) | (optional) |
| `ATELIER_SERVER_MODE` | Runtime mode (`production` or `mock`) | (required; `mock` for local dev, `production` on server) |
| `ATELIER_SERVER_PORT` | Manager API port | `4000` |
| `ATELIER_SERVER_HOST` | Manager API bind host | `0.0.0.0` |
| `ATELIER_MAX_SANDBOXES` | Maximum concurrent sandboxes | `20` |

### Dashboard Runtime Config

Dashboard runtime config is served by Manager at `GET /config`. No `VITE_*` vars needed for production.

## Domains

Domains are configurable. Default pattern:

| Service | URL Pattern |
|---------|-------------|
| Dashboard | `sandbox.{baseDomain}` |
| VSCode | `sandbox-{id}.{baseDomain}` |
| OpenCode | `opencode-{id}.{baseDomain}` |
| Browser | `browser-{id}.{baseDomain}` |
| Dev (named) | `dev-{name}-{id}.{baseDomain}` |
| Dev (default) | `dev-{id}.{baseDomain}` |
| Dev (alias) | `dev-{name}-{alias}-{id}.{baseDomain}` |

## Pod Communication

Agent runs inside each sandbox pod, listening on TCP port 9998. Manager reaches agent via pod IP obtained from the K8s API (`pod.status.podIP`).

## Registry (Verdaccio)

Runs as a K8s Deployment in the `atelier-system` namespace on port 4873, accessible from sandbox pods via K8s Service DNS (`verdaccio.atelier-system.svc:4873`). Sandboxes get `npmrc`/`bunfig`/`yarnrc` injected. Enable/disable via API.

## Network Architecture

```
Internet → Caddy (:443, TLS) → K8s Ingress → Service → Pod:port
```

- Sandbox pods get IPs from K8s CNI (10.42.x.x range)
- K8s Services provide stable endpoints for each sandbox
- Ingress resources handle host-based routing (sandbox-{id}.{domain})

## Storage (TopoLVM CSI)

PVC snapshots via TopoLVM for instant CoW clones:

```
TopoLVM Thin Pool (LVM VG on node)
├── PVCs (per sandbox)          # Workspace data (cloned from VolumeSnapshot)
├── VolumeSnapshots             # Per-workspace prebuilds
└── Temp PVCs                   # Created during prebuild, deleted after snapshot
```

### K8s Resources

| Resource | Namespace | Purpose |
|----------|-----------|---------|
| Sandbox Pod + Service + Ingress | `atelier-sandboxes` | Per-sandbox compute + routing |
| Workspace PVC | `atelier-sandboxes` | Per-sandbox data volume (from VolumeSnapshot) |
| VolumeSnapshot | `atelier-sandboxes` | Prebuild snapshots (CoW clones for new PVCs) |
| Shared binaries PV | `atelier-sandboxes` | code-server + OpenCode (ReadOnlyMany) |
| Manager Deployment + PVC | `atelier-system` | Orchestration API + SQLite database |
| Zot Deployment + PVC | `atelier-system` | OCI registry for base images |
| Verdaccio Deployment + PVC | `atelier-system` | npm package cache |

## Deployment

From dev machine (requires `SSH_KEY_PATH`, `SSH_USER`, `SSH_HOST` env vars):

```bash
bun run deploy    # Builds + SCP + restart services
```

Target: `helm install` replaces manual deployment in Phase 3.

## Resource Cleanup

On sandbox destruction (K8s label-based):
1. Delete all resources with label `atelier.dev/sandbox={id}` (pods, services, configmaps, PVCs, ingresses, volumesnapshots)
2. Explicit pod delete as fallback (idempotent, catches 404)
3. Database record delete
4. Event emission for UI updates

K8s garbage collection handles orphaned resources automatically.
