# Critical Constraints

Things that will break the system if ignored.

## Bun vs Node.js Runtimes

| Component | Runtime | Why |
|-----------|---------|-----|
| Manager API | **Bun** | Performance, native Elysia |
| Dashboard | **Vite/Browser** | React SPA, static deploy |
| Sandbox Agent | **Rust (Tokio/Hyper)** | Lightweight, vsock support, no AVX issues in FC |
| CLI (server) | **Bun** (compiled) | Runs on host, not VM |

```bash
# Agent build - Rust compile for Linux
cargo build --release --target x86_64-unknown-linux-musl
```

## LVM Snapshots

```bash
# ALWAYS use -kn to activate snapshot immediately
lvcreate -s -kn -n sandbox-xxx sandbox-vg/base-volume
```

Without `-kn`, the volume won't be visible to Firecracker.

## Cloudflare

If using Cloudflare, disable Rocket Loader — it breaks WebSocket connections used by code-server and the terminal.

## Filesystem Resize

After LVM clone, run inside VM:

```bash
test -e /dev/vda || mknod /dev/vda b 254 0
resize2fs /dev/vda
```

Manager runs this automatically via AgentOperations.

## Network Forwarding

Ensure `net.ipv4.ip_forward=1` is set and iptables rules exist:
1. DROP intra-bridge traffic (prevents sandbox-to-sandbox access)
2. MASQUERADE outbound traffic from bridge subnet
3. FORWARD rules for bridge-to-host interface

Bridge name is configurable via `network.bridgeName` (default `br0`).

## Caddy Route Ordering

Wildcard fallback must be last. `CaddyService` auto-manages this by deleting and re-adding wildcard after each specific route addition.

## Mock Mode

Manager runs without KVM/LVM locally:

```bash
ATELIER_SERVER_MODE=mock bun run dev
```

All infrastructure services check `isMock()` and return mock responses.

## Shared Binaries Mount

Firecracker attaches shared binaries as `/dev/vdb` (read-only ext4 image). Guest init mounts it at `/opt/shared`. If unmounted, code-server and opencode (`/opt/shared/bin/*`) will fail. On snapshot restore, manager remounts it explicitly.

## Snapshot Restore Paths

Firecracker snapshot restore requires drive and vsock paths to match the original VM. The manager uses symlinks to ensure path compatibility. Do not change the sandbox path layout (`getSandboxPaths()`) without updating restore logic.

## Cleanup Order

On sandbox destruction, resources must be freed in order:
1. Kill Firecracker PID
2. Remove Unix socket
3. Delete LVM volume
4. Delete TAP device
5. Release IP allocation
6. Remove Caddy routes
7. Remove SSH proxy route

Wrong order causes resource leaks.

## Passwordless Sudo

Manager runs as the `atelier` user and uses `sudo -n` for host operations (LVM, network, mounts). Missing `/etc/sudoers.d/atelier` entries cause silent failures. The CLI provisioning step creates this file.

## CLI Runs As Root

The `atelier` CLI must run as root (system-level operations: systemd, iptables, LVM, sudoers). The install script exits if not root.
