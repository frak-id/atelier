# Infrastructure

## Domains

| Service | URL |
|---------|-----|
| API | `sandbox-api.nivelais.com` |
| Dashboard | `sandbox-dash.nivelais.com` |
| VSCode | `sandbox-{id}.nivelais.com` |
| OpenCode | `opencode-{id}.nivelais.com` |
| Terminal | `terminal-{id}.nivelais.com` |

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

Run on server as root:

```bash
frak-sandbox setup             # Full server setup
frak-sandbox images build      # Build rootfs image
frak-sandbox vm start          # Test VM
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
