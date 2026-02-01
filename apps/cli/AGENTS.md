# CLI

Server provisioning and management CLI. Compiles to native Linux binary. Must run as root.

## Build

```bash
bun build src/index.ts --compile --target=bun-linux-x64 --outfile dist/frak-sandbox-linux-x64
```

## Commands

Provisioning (one-time): `setup`, `base`, `firecracker`, `network`, `storage`, `nfs`, `ssh-proxy`.
Service control: `manager start|stop|restart|status|logs`.
Images: `images [image-id]` — build base image (Docker → ext4 → LVM).
Debug: `debug-vm start|stop|status|ssh`.

## Conventions

- Interactive prompts via `@clack/prompts`
- Shell execution via `Bun.$`
- Each command in `src/commands/*.ts`, registered in `src/index.ts` COMMANDS object
- Commands are idempotent — safe to re-run
