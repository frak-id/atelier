# AGENTS.md - Frak Sandbox Development Guide

## Project Overview
Firecracker microVM-based development environment orchestrator. Creates isolated sandboxes with VSCode (code-server) and OpenCode running inside VMs.

## Repository Structure
```
apps/manager/       # Main API server (Elysia + Bun)
packages/shared/    # Shared constants, types
packages/sandbox-agent/  # Agent running inside VMs (Node.js, NOT Bun)
infra/cli/          # Deployment CLI
infra/caddy/        # Caddyfile for reverse proxy
infra/images/       # Docker images for rootfs
```

## Build & Development Commands

```bash
# Install dependencies
bun install

# Lint (Biome)
bun run lint

# Format
bun run format

# Check (lint + format)
bun run check

# Manager development (with watch)
cd apps/manager && bun run dev

# Build manager for production
cd apps/manager && bun build --bundle --target=bun --minify --outfile=server.js src/index.ts

# Build sandbox-agent (MUST use --target=node, Bun crashes in Firecracker)
cd packages/sandbox-agent && bun build --bundle --target=node --outfile=dist/agent.mjs src/index.ts
```

## Code Style (Biome)

- **Indent**: 2 spaces
- **Line width**: 80 characters
- **Quotes**: Double quotes (`"`)
- **Semicolons**: Always
- **Imports**: Organized automatically, use `.ts` extensions

```typescript
// Correct import style
import { nanoid } from "nanoid";
import type { Sandbox } from "@frak-sandbox/shared/types";
import { FIRECRACKER } from "@frak-sandbox/shared/constants";
import { exec } from "../lib/shell.ts";
```

## TypeScript Guidelines

- **Strict mode** enabled
- **noUncheckedIndexedAccess**: true (always check array/object access)
- Use `type` imports for type-only imports
- File extension: `.ts` required in imports

```typescript
// Types - use 'type' keyword
import type { Sandbox, Project } from "@frak-sandbox/shared/types";

// Service pattern - object with async methods
export const MyService = {
  async doSomething(id: string): Promise<Result> {
    // implementation
  },
};

// Logger pattern
const log = createChildLogger("service-name");
log.info({ contextData }, "Message");
log.error({ error }, "Error message");
```

## Server Access (SSH)

Environment variables in `.env`:
- `SSH_HOST` - Server IP address
- `SSH_USER` - SSH username  
- `SSH_KEY_PATH` - Path to SSH private key
- `SSH_KEY_PASSPHRASE` - Key passphrase

```bash
# SSH to server
ssh -i $SSH_KEY_PATH $SSH_USER@$SSH_HOST

# Copy files to server
scp -i $SSH_KEY_PATH localfile $SSH_USER@$SSH_HOST:/remote/path

# Execute remote command
ssh -i $SSH_KEY_PATH $SSH_USER@$SSH_HOST "command here"
```

## Deployment

```bash
# Deploy manager to server
cd apps/manager
bun build --bundle --target=bun --minify --outfile=server.js src/index.ts
scp -i $SSH_KEY_PATH server.js $SSH_USER@$SSH_HOST:/opt/frak-sandbox/server.js
ssh -i $SSH_KEY_PATH $SSH_USER@$SSH_HOST "systemctl restart sandbox-manager"

# Deploy Caddyfile
scp -i $SSH_KEY_PATH infra/caddy/Caddyfile $SSH_USER@$SSH_HOST:/etc/caddy/Caddyfile
ssh -i $SSH_KEY_PATH $SSH_USER@$SSH_HOST "caddy reload --config /etc/caddy/Caddyfile"
```

## Architecture Notes

### Domain Structure (Flat subdomains)
- API: `sandbox-api.nivelais.com`
- Dashboard: `sandbox-dash.nivelais.com`
- VSCode: `sandbox-{id}.nivelais.com`
- OpenCode: `opencode-{id}.nivelais.com`

### Key Services
- **FirecrackerService**: VM lifecycle management
- **CaddyService**: Dynamic route registration via admin API
- **StorageService**: LVM thin provisioning for sandbox volumes
- **NetworkService**: TAP device and IP allocation

### VM Communication
- Sandbox agent runs on port 9999 inside VM
- Use agent's `/exec` endpoint for running commands in VM:
```bash
curl -X POST http://{vm-ip}:9999/exec \
  -H "Content-Type: application/json" \
  -d '{"command":"your command here"}'
```

## Critical Gotchas

### Bun in Firecracker VMs - DOES NOT WORK
Bun crashes with SIGILL (illegal instruction) inside Firecracker due to AVX instruction issues. Use Node.js for any code running inside VMs.

### LVM Snapshots Need Activation
When creating LVM thin snapshots, use `-kn` flag to disable skip-activation:
```bash
lvcreate -s -kn -n volume-name vg/source-volume
```

### Network Forwarding Rules
Ensure iptables forwarding rules exist for sandbox network:
```bash
iptables -I FORWARD -i br0 -o {external-iface} -j ACCEPT
iptables -I FORWARD -i {external-iface} -o br0 -m state --state RELATED,ESTABLISHED -j ACCEPT
iptables -t nat -A POSTROUTING -s 172.16.0.0/24 -o {external-iface} -j MASQUERADE
```

### Filesystem Resize After LVM Clone
LVM volumes may be larger than the filesystem inside. Resize with:
```bash
resize2fs /dev/vda  # Inside VM
```

### Cloudflare Rocket Loader
Breaks VSCode. Disable in Cloudflare dashboard: Speed > Optimization > Rocket Loader OFF

## Testing VM Commands

```bash
# Check sandbox health
curl http://{vm-ip}:9999/health

# Execute command in sandbox
curl -X POST http://{vm-ip}:9999/exec \
  -H "Content-Type: application/json" \
  -d '{"command":"cat /proc/cpuinfo | head -5"}'

# Check services
curl http://{vm-ip}:9999/health | jq '.services'
```

## API Endpoints

```bash
# Health check
curl https://sandbox-api.nivelais.com/health

# List sandboxes  
curl https://sandbox-api.nivelais.com/api/sandboxes

# Create sandbox
curl -X POST https://sandbox-api.nivelais.com/api/sandboxes \
  -H "Content-Type: application/json" \
  -d '{"name":"my-sandbox","imageId":"dev-base"}'

# Delete sandbox
curl -X DELETE https://sandbox-api.nivelais.com/api/sandboxes/{id}
```
