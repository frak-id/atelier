# CLI

Server provisioning and management CLI. Runs on the host server (not in VMs).

## Critical: Root Required

```bash
# CLI must run as root for system-level operations
sudo frak-sandbox setup
```

## Build Target

```bash
# Compiles to native Linux binary
bun build src/index.ts --compile --target=bun-linux-x64 --outfile dist/frak-sandbox-linux-x64
```

## Command Structure

```
frak-sandbox [command] [subcommand]
```

### Provisioning (one-time setup)

| Command | Purpose |
|---------|---------|
| `setup` | Full server setup (new servers) |
| `base` | Install Bun, Docker, Caddy, verify KVM |
| `firecracker` | Download Firecracker, kernel, rootfs |
| `network` | Configure persistent br0 bridge |
| `storage` | Configure LVM thin provisioning |
| `nfs` | Configure NFS server for shared package cache |
| `ssh-proxy` | Install sshpiper for sandbox SSH |

### Service Control

| Command | Subcommands | Purpose |
|---------|-------------|---------|
| `manager` | start, stop, restart, status, logs | Manage API service |

### Image Building

| Command | Purpose |
|---------|---------|
| `images [image-id]` | Build base image (Docker → ext4 → LVM) |

### Debugging

| Command | Subcommands | Purpose |
|---------|-------------|---------|
| `debug-vm` | start, stop, status, ssh | Debug VM (isolated from Manager) |

## Runtime Operations

For runtime operations, use the Manager API instead of CLI:

```bash
# List sandboxes
curl http://localhost:4000/sandboxes

# List images with availability
curl http://localhost:4000/images

# System stats
curl http://localhost:4000/system/stats
```

## Conventions

- **Interactive prompts** — Uses `@clack/prompts` for user input
- **Shell execution** — Commands run via `Bun.$` (shell.ts wrapper)
- **Command pattern** — Each command in `src/commands/*.ts`
- **Context-free** — No state between command runs
- **Idempotent** — Safe to re-run setup commands

## Where to Look

| Task | File |
|------|------|
| Add new command | `src/index.ts` (COMMANDS object) |
| Base setup logic | `src/commands/base-setup.ts` |
| Network configuration | `src/commands/setup-network.ts` |
| LVM setup | `src/commands/setup-storage.ts` |
| Manager deployment | `src/commands/deploy-manager.ts` |
| Image building | `src/commands/images.ts` |
| Debug VM | `src/commands/debug-vm.ts` |

## See Also

- [Constraints](../../docs/constraints.md) — Network, LVM flags
- [Infrastructure](../../docs/infrastructure.md) — Network architecture
