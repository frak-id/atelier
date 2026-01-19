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

| Command | Subcommands | Purpose |
|---------|-------------|---------|
| `setup` | - | Full server setup (new servers) |
| `base` | - | Install Bun, Docker, Caddy, verify KVM |
| `firecracker` | - | Download Firecracker, kernel, rootfs |
| `network` | - | Configure persistent br0 bridge |
| `storage` | - | Configure LVM thin provisioning |
| `ssh-proxy` | - | Install sshpiper for sandbox SSH |
| `manager` | start, stop, restart, status, logs | Manage API service |
| `images` | build, list, status | Manage base images |
| `vm` | start, stop, status, ssh | Test VM operations |

## Conventions

- **Interactive prompts** - Uses `@clack/prompts` for user input
- **Shell execution** - Commands run via `Bun.$` (shell.ts wrapper)
- **Command pattern** - Each command in `src/commands/*.ts`
- **Context-free** - No state between command runs
- **Idempotent** - Safe to re-run setup commands

## Where to Look

| Task | File |
|------|------|
| Add new command | `src/index.ts` (COMMANDS object) |
| Base setup logic | `src/commands/base-setup.ts` |
| Network configuration | `src/commands/setup-network.ts` |
| LVM setup | `src/commands/setup-storage.ts` |
| Manager deployment | `src/commands/deploy-manager.ts` |
| Image building | `src/commands/images.ts` |

## See Also

- [Constraints](../../docs/constraints.md) - Network, LVM flags
- [Infrastructure](../../docs/infrastructure.md) - Network architecture
