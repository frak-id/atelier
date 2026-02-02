# Infrastructure

## Configuration

FRAK Sandbox uses a unified configuration system. Values can be set via:

1. **Environment variables** (highest priority)
2. **Config file** (`/etc/frak-sandbox/sandbox.config.json` or `FRAK_CONFIG` env var)
3. **Defaults** (fallback)

See `sandbox.config.example.json` in the repository root for all available options.

### Key Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `FRAK_SANDBOX_DOMAIN_SUFFIX` | Domain suffix for sandboxes | `localhost` |
| `FRAK_API_DOMAIN` | API domain | `sandbox-api.{suffix}` |
| `FRAK_DASHBOARD_DOMAIN` | Dashboard domain | `sandbox-dash.{suffix}` |
| `FRAK_DNS_SERVERS` | DNS servers (comma-separated) | `8.8.8.8,8.8.4.4` |
| `GITHUB_CLIENT_ID` | GitHub OAuth client ID | (required for production) |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth client secret | (required for production) |
| `JWT_SECRET` | JWT signing secret | (required for production) |

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
frak-sandbox init              # Full install
frak-sandbox images build      # Build rootfs image
frak-sandbox debug-vm start    # Test VM
frak-sandbox manager status    # Check API health
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
