# Infrastructure

## Configuration

L'atelier uses a unified configuration system. Values can be set via:

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
| `ATELIER_SSH_PROXY_PORT` | SSH proxy listen port | `2222` |
| `ATELIER_SSH_PROXY_HOSTNAME` | SSH proxy hostname (empty = derived) | (derived) |
| `ATELIER_GITHUB_CLIENT_ID` | GitHub OAuth client ID | (required for production) |
| `ATELIER_GITHUB_CLIENT_SECRET` | GitHub OAuth client secret | (required for production) |
| `ATELIER_JWT_SECRET` | JWT signing secret | (required for production) |
| `ATELIER_AUTH_ALLOWED_ORG` | Allowed GitHub organization | (optional) |
| `ATELIER_AUTH_ALLOWED_USERS` | Allowed GitHub usernames (comma-separated) | (optional) |
| `ATELIER_SERVER_MODE` | Runtime mode (`production` or `mock`) | (required; `mock` for local dev, `production` on server) |
| `ATELIER_SERVER_PORT` | Manager API port | `4000` |
| `ATELIER_SERVER_HOST` | Manager API bind host | `0.0.0.0` |
| `ATELIER_MAX_SANDBOXES` | Maximum concurrent sandboxes | `20` |
| `ATELIER_BRIDGE_NAME` | Bridge device name | `br0` |
| `ATELIER_BRIDGE_IP` | Bridge IP address (host-side) | `172.16.0.1` |
| `ATELIER_GUEST_IP_START` | First guest IP last octet | `10` |
| `ATELIER_DNS_SERVERS` | DNS servers (comma-separated) | `8.8.8.8,8.8.4.4` |

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

### SSH Proxy

- **Host**: `ssh.{baseDomain}` (default)
- **Port**: `2222`
- **Routing**: By username (`sandboxId`)
- **Usage**: `ssh <sandboxId>@ssh.<baseDomain> -p 2222`

## VM Communication

Agent uses Firecracker vsock (guest port 9998). Host reaches agent via vsock UDS at `/var/lib/sandbox/sockets/<id>.vsock`.

## Registry (Verdaccio)

Runs programmatically in the manager on port 4873 (default), accessible from VMs via bridge IP. Sandboxes get `npmrc`/`bunfig`/`yarnrc` injected. Enable/disable via API.

## Network Architecture

```
Internet -> Caddy (:443) -> br0 bridge -> tap-{first8chars} -> VM (172.16.0.x)
```

- Bridge: `br0` at `172.16.0.1/24`
- VMs get IPs starting at `172.16.0.10`
- NAT via iptables MASQUERADE

## Storage (LVM)

Thin provisioning for instant CoW snapshots:

```
sandbox-vg/
├── thin-pool              # Thin pool
├── image-{imageId}        # Base image (read-only template)
├── prebuild-{workspaceId} # Per-project snapshots
└── sandbox-{sandboxId}    # Per-sandbox CoW clones
```

### Host Paths

| Path | Description |
|------|-------------|
| `/var/lib/sandbox/sockets/` | Firecracker UDS sockets |
| `/var/log/sandbox/` | Sandbox logs |
| `/var/lib/sandbox/overlays/` | Non-LVM overlay fallback (`<id>.ext4`) |
| `/var/lib/sandbox/snapshots/` | Firecracker snapshots |

## Server CLI

Run on server (CLI auto-sudo for privileged operations):

```bash
atelier init              # Full install
atelier images dev-base   # Build rootfs image (or `atelier images` for interactive)
atelier debug-vm start    # Test VM
atelier manager status    # Check API health
```

## Deployment

From dev machine (requires `SSH_KEY_PATH`, `SSH_USER`, `SSH_HOST` env vars):

```bash
bun run deploy    # Builds + SCP + restart services
```

## Resource Cleanup

On sandbox destruction (order matters):
1. Kill Firecracker PID
2. Remove socket + vsock + pid + log files
3. Delete LVM volume (or overlay fallback at `/var/lib/sandbox/overlays/<id>.ext4`)
4. Delete TAP device
5. Release IP allocation
6. Remove Caddy routes (vscode/opencode/browser + all `dev-*` routes)
7. Remove SSH proxy route

If manager crashes mid-destruction, resources may leak.
