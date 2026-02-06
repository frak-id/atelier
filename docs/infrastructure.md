# Infrastructure

## Configuration

L'atelier uses a unified configuration system. Values can be set via:

1. **Environment variables** (highest priority)
2. **Config file** (`/etc/atelier/sandbox.config.json` or `ATELIER_CONFIG` env var)
3. **Defaults** (fallback)

See `sandbox.config.example.json` in the repository root for all available options.

### Key Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ATELIER_CONFIG` | Override config file path | `/etc/atelier/sandbox.config.json` |
| `ATELIER_BASE_DOMAIN` | Base domain (e.g. `example.com`) | `localhost` |
| `ATELIER_DASHBOARD_DOMAIN` | Dashboard domain (empty = derived from base domain) | (derived) |
| `ATELIER_TLS_EMAIL` | TLS email for ACME / Let's Encrypt | (required for production HTTPS) |
| `ATELIER_SSH_PROXY_PORT` | SSH proxy listen port | `2222` |
| `ATELIER_SSH_PROXY_HOSTNAME` | SSH proxy hostname (empty = derived) | (derived) |
| `ATELIER_GITHUB_CLIENT_ID` | GitHub OAuth client ID | (required for production) |
| `ATELIER_GITHUB_CLIENT_SECRET` | GitHub OAuth client secret | (required for production) |
| `ATELIER_JWT_SECRET` | JWT signing secret | (required for production) |
| `ATELIER_SERVER_MODE` | Runtime mode (`production` or `mock`) | `mock` |
| `ATELIER_SERVER_PORT` | Manager API port | `4000` |
| `ATELIER_SERVER_HOST` | Manager API bind host | `0.0.0.0` |
| `ATELIER_MAX_SANDBOXES` | Maximum concurrent sandboxes | `20` |
| `ATELIER_BRIDGE_NAME` | Bridge device name | `br0` |
| `ATELIER_BRIDGE_IP` | Bridge IP address (host-side) | `172.16.0.1` |
| `ATELIER_GUEST_IP_START` | First guest IP last octet | `10` |
| `ATELIER_DNS_SERVERS` | DNS servers (comma-separated) | `8.8.8.8,8.8.4.4` |

### Dashboard Build Variables

For Vite (build-time):

| Variable | Description |
|----------|-------------|
| `VITE_API_URL` | API URL (empty for proxy, full URL for production) |
| `VITE_SSH_HOSTNAME` | SSH proxy hostname |

## Domains

Domains are configurable. Default pattern:

| Service | URL Pattern |
|---------|-------------|
| API | `sandbox-api.{DOMAIN_SUFFIX}` |
| Dashboard | `sandbox-dash.{DOMAIN_SUFFIX}` |
| VSCode | `sandbox-{id}.{DOMAIN_SUFFIX}` |
| OpenCode | `opencode-{id}.{DOMAIN_SUFFIX}` |

## VM Communication

Agent runs on port 9999 inside each VM:

```bash
curl http://{vm-ip}:9999/health
curl -X POST http://{vm-ip}:9999/exec -d '{"command":"ls"}'
```

## Network Architecture

```
Internet -> Caddy (:443) -> br0 bridge -> tap-{id} -> VM (172.16.0.x)
```

- Bridge: `br0` at `172.16.0.1/24`
- VMs get IPs starting at `172.16.0.10`
- NAT via iptables MASQUERADE

## Storage (LVM)

Thin provisioning for instant CoW snapshots:

```
sandbox-vg/
├── thin-pool          # Thin pool
├── base-rootfs        # Base image (read-only template)
├── prebuild-{project} # Per-project snapshots
└── sandbox-{id}       # Per-sandbox CoW clones
```

## Server CLI

Run on server (CLI auto-sudo for privileged operations):

```bash
atelier init              # Full install
atelier images build      # Build rootfs image
atelier debug-vm start    # Test VM
atelier manager status    # Check API health
```

## Deployment

From dev machine:

```bash
bun run deploy    # Builds + SCP + restart services
```

## Resource Cleanup

On sandbox destruction (order matters):
1. Kill Firecracker PID
2. Remove Unix socket
3. Delete LVM volume
4. Delete TAP device
5. Release IP allocation
6. Remove Caddy routes

If manager crashes mid-destruction, resources may leak.
