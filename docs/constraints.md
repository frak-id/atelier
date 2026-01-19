# Critical Constraints

Things that will break the system if ignored.

## Bun vs Node.js Runtimes

| Component | Runtime | Why |
|-----------|---------|-----|
| Manager API | **Bun** | Performance, native Elysia |
| Dashboard | **Bun** (Vite) | Standard |
| Sandbox Agent | **Node.js** | Bun crashes in Firecracker (SIGILL/AVX) |
| CLI (server) | **Bun** (compiled) | Runs on host, not VM |

```bash
# Agent build - MUST use --target=node
bun build --bundle --target=node --outfile=dist/agent.mjs src/index.ts
```

## LVM Snapshots

```bash
# ALWAYS use -kn to activate snapshot immediately
lvcreate -s -kn -n sandbox-xxx sandbox-vg/base-volume
```

Without `-kn`, the volume won't be visible to Firecracker.

## Cloudflare

Disable Rocket Loader - breaks VSCode/code-server WebSocket connections.

## Filesystem Resize

After LVM clone, run inside VM:

```bash
resize2fs /dev/vda
```

## Network Forwarding

Ensure iptables rules exist for br0 <-> external traffic (NAT masquerade).

## Caddy Route Ordering

Wildcard fallback must be last. `CaddyService` auto-manages this by deleting and re-adding wildcard after each specific route addition.

## Mock Mode

Manager runs without KVM/LVM locally:

```bash
SANDBOX_MODE=mock bun run dev
```

All infrastructure services check `config.isMock()` and return mock responses.
