# Architecture

> Firecracker microVM orchestrator built as a Bun monorepo

## Technology Stack

### Application Layer

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | **Bun** | JS/TS runtime, bundler, package manager |
| Monorepo | **Bun Workspaces** | Workspace management |
| API Framework | **ElysiaJS** | Type-safe HTTP server |
| Frontend | **React** + **TanStack Router/Query** | Dashboard SPA |
| Frontend Build | **Vite** | Dev server and bundling |
| Styling | **Tailwind CSS** + **shadcn/ui** | UI components |
| Validation | **TypeBox** | Runtime validation (Elysia native) |

### Infrastructure Layer

| Component | Technology | Purpose |
|-----------|------------|---------|
| MicroVM | **Firecracker** | Fast, secure VM isolation |
| Storage | **LVM Thin Provisioning** | CoW snapshots for fast clones |
| Reverse Proxy | **Caddy** | Dynamic routing, auto HTTPS |
| Process Manager | **systemd** | Service lifecycle |
| Container Build | **Docker** | Rootfs image building only |
| Database | **SQLite** (Drizzle ORM) | Sandbox, workspace, task, config, and auth state |

---

## Monorepo Structure

```
atelier/
├── apps/
│   ├── manager/          # Sandbox orchestration API (ElysiaJS)
│   ├── dashboard/        # Admin web interface (React + Vite)
│   ├── cli/              # Server provisioning CLI (Bun compiled binary)
│   └── agent-rust/       # In-VM agent (Rust — lightweight, no AVX)
├── packages/
│   └── shared/           # Shared types, constants, errors
├── infra/
│   ├── caddy/            # Caddyfile for static routes
│   ├── images/           # Rootfs Dockerfiles
│   ├── scripts/          # Install scripts
│   └── systemd/          # Service definitions
└── scripts/
    └── deploy.ts         # SSH deployment (manager + agent + dashboard)
```

---

## Core Concepts

### Sandbox Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Sandbox Lifecycle                                    │
│                                                                             │
│       ┌──────────┐       ┌──────────┐       ┌──────────┐       ┌──────────┐  │
│       │ CREATING │──────►│ RUNNING  │──────►│ STOPPED  │──────►│  ERROR   │  │
│       └──────────┘       └──────────┘       └──────────┘       └──────────┘  │
│                                                                             │
│  States:                                                                    │
│  • CREATING - VM booting, services starting                                 │
│  • RUNNING  - Fully operational                                             │
│  • STOPPED  - VM process killed, disk preserved                             │
│  • ERROR    - Failed to start or crashed                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Prebuild Flow

```
Without Prebuilds (slow, ~2-5 minutes):
  Boot VM  →  Clone Repo  →  run workspace init commands  →  Ready

With Prebuilds (fast):

  One-time (background):
  Boot VM  →  Clone Repo  →  run workspace init commands  →  Snapshot

  Every spawn (instant):
  Restore Snapshot (LVM + Firecracker Memory)  →  Ready  (<200ms)
```

Prebuilds run expensive initialization (git clone, dependency install, build)
**once** and snapshot the result as both an LVM thin volume and a Firecracker
VM state snapshot (including memory). Subsequent sandboxes restore from these
snapshots instantly.

---

## Network Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Host Network                              │
│                                                                  │
│  ┌──────────────┐                                                │
│  │   eth0       │◄─── Public IP                                  │
│  │   (WAN)      │                                                │
│  └──────┬───────┘                                                │
│         │                                                        │
│         │ NAT (iptables MASQUERADE)                              │
│         │                                                        │
│  ┌──────▼───────┐                                                │
│  │    br0       │◄─── 172.16.0.1/24 (Bridge)                    │
│  │  (Bridge)    │                                                │
│  └──────┬───────┘                                                │
│         │                                                        │
│    ┌────┴────┬────────┬────────┐                                 │
│    │         │        │        │                                 │
│ ┌──▼──┐  ┌──▼──┐  ┌──▼──┐  ┌──▼──┐                             │
│ │tap-1│  │tap-2│  │tap-3│  │tap-n│  TAP devices                │
│ └──┬──┘  └──┬──┘  └──┬──┘  └──┬──┘                             │
│    │        │        │        │                                  │
│ ┌──▼──┐  ┌──▼──┐  ┌──▼──┐  ┌──▼──┐                             │
│ │VM 1 │  │VM 2 │  │VM 3 │  │VM n │  Firecracker VMs            │
│ │.10  │  │.11  │  │.12  │  │.x   │  172.16.0.x                 │
│ └─────┘  └─────┘  └─────┘  └─────┘                             │
└─────────────────────────────────────────────────────────────────┘

External traffic:
  Internet → Caddy (:443) → br0 → tap-x → VM:port
```

---

## Caddy Reverse Proxy

```
┌─────────────────────────────────────────────────────────────────┐
│                         Caddy                                   │
│                                                                 │
│  Static Routes (Caddyfile):                                     │
│  └── {DOMAIN}                                                   │
│      ├── /api/*, /auth/*, /config, /health, /swagger*           │
│      │   → localhost:4000 (Manager)                             │
│      └── * → Static Files (Dashboard SPA)                       │
│                                                                 │
│  Dynamic Routes (Admin API, protected via forward-auth):        │
│  ├── sandbox-{id}.{DOMAIN}  → 172.16.0.x:8080 (VSCode)          │
│  ├── opencode-{id}.{DOMAIN} → 172.16.0.x:3000 (OpenCode)        │
│  ├── dev-{name}-{id}.{DOMAIN} → 172.16.0.x:{port} (Dev)         │
│  └── browser-{id}.{DOMAIN}  → 172.16.0.x:7681 (KasmVNC)         │
│                                                                 │
│  Features:                                                      │
│  ├── Automatic HTTPS (ACME HTTP-01)                             │
│  ├── Manual TLS (certPath/keyPath)                              │
│  └── Zero-downtime route updates via Admin API                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Firecracker VM Anatomy

```
┌─────────────────────────────────────────────────────────────────┐
│                    Firecracker MicroVM                          │
│                                                                 │
│  Resources (configurable per sandbox):                          │
│  ├── vCPUs: 1-8                                                 │
│  ├── RAM: 512MB - 16GB                                          │
│  └── Boot time: ~125ms                                          │
│                                                                 │
│  Storage:                                                       │
│  ├── /dev/vda → LVM thin volume (CoW clone of base/prebuild)    │
│  └── /dev/vdb → /opt/shared (ro ext4 image: tools & binaries)   │
│                                                                 │
│  Filesystem:                                                    │
│  /                                                              │
│  ├── usr/local/bin/                                             │
│  │   └── sandbox-agent      # In-VM agent binary                │
│  ├── opt/shared/bin/                                            │
│  │   ├── code-server        # VSCode Server                     │
│  │   ├── opencode           # OpenCode CLI                      │
│  │   └── node, bun, git     # Dev tools                         │
│  ├── home/dev/                                                  │
│  │   ├── workspace/         # Project code                      │
│  │   └── SANDBOX.md         # Agent skill file                  │
│  ├── etc/sandbox/                                               │
│  │   ├── config.json        # Sandbox metadata                  │
│  │   └── secrets/.env       # Injected secrets                  │
│  └── var/log/sandbox/       # Service logs                      │
│                                                                 │
│  Services:                                                      │
│  ├── sandbox-init starts sshd + sandbox-agent                   │
│  ├── agent starts services after manager pushes config:         │
│  │   ├── sandbox-agent (vsock:9998)                             │
│  │   ├── code-server (:8080)                                    │
│  │   ├── opencode serve (:3000)                                 │
│  │   ├── terminal (:7681)   # WebSocket PTY                     │
│  │   └── browser            # KasmVNC/Chromium on demand        │
│  └── sshd (:22)                                                 │
│                                                                 │
│  Network:                                                       │
│  └── eth0 → 172.16.0.x/24, gateway 172.16.0.1                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Storage Architecture

### Why LVM Thin Provisioning

| Approach | Snapshot Time | Space Efficiency | Firecracker Ready |
|----------|---------------|------------------|-------------------|
| Sparse ext4 files | ~200ms (mkfs) | Poor | ✅ |
| **LVM Thin** | **<5ms** | **Excellent (CoW)** | **✅** |
| Btrfs subvolumes | <5ms | Excellent | ❌ (not block device) |
| ZFS zvols | <5ms | Excellent | ✅ |

### Storage Layout

```
┌─────────────────────────────────────────────────────────────────┐
│                    LVM Thin Pool                                │
│                    (atelier-vg/thin-pool)                       │
│                                                                 │
│  Base Images (read-only templates):                             │
│  ┌──────────────────────────┐  ┌──────────────────────────┐     │
│  │ image-dev-base (5GB)     │  │ image-dev-cloud (7GB)    │     │
│  │ Debian Bookworm + Node22 │  │ dev-base + Cloud SDKs    │     │
│  └──────────────────────────┘  └──────────────────────────┘     │
│                                                                 │
│  Prebuild Volumes (per-workspace snapshots):                    │
│  ┌──────────────────────┐  ┌──────────────────────┐             │
│  │ prebuild-myproject   │  │ prebuild-backend     │             │
│  │ (clone of image +    │  │ (clone of image +    │             │
│  │  repo + init deps)   │  │  repo + init deps)   │             │
│  └──────────────────────┘  └──────────────────────┘             │
│           │                          │                          │
│           │ instant clone            │ instant clone            │
│           ▼                          ▼                          │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ sandbox-abc │  │ sandbox-def │  │ sandbox-ghi │              │
│  │ (CoW, ~0 MB │  │ (CoW, ~0 MB │  │ (CoW, ~5 MB │              │
│  │  initial)   │  │  initial)   │  │  delta)     │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│                                                                 │
│  Only changed blocks are stored per sandbox!                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Sandbox Agent

A lightweight Rust binary running inside each VM, communicating with the manager
via Firecracker vsock.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Sandbox Agent (vsock:9998)                   │
│                                                                 │
│  Core Responsibilities:                                         │
│  ├── vsock HTTP API for manager orchestration                   │
│  ├── Service & dev process lifecycle management                 │
│  ├── Workspace config application                               │
│  ├── File system operations (writes, git helpers)               │
│  ├── Command execution (/exec)                                  │
│  ├── Interactive terminal sessions (WebSocket PTY)              │
│  └── Resource metrics (CPU, memory, disk)                       │
└─────────────────────────────────────────────────────────────────┘
```

**Why Rust?** Bun crashes inside Firecracker VMs due to AVX instruction issues
(SIGILL). The agent is compiled as a static musl binary for maximum
compatibility.

---

## API Overview

The Manager exposes a REST API on port 4000:

| Group | Endpoints | Description |
|-------|-----------|-------------|
| Health | `/health`, `/health/live`, `/health/ready` | Liveness and readiness probes |
| Sandboxes | `/api/sandboxes` | Full sandbox lifecycle |
| Workspaces | `/api/workspaces` | Workspace CRUD and prebuilds |
| Tasks | `/api/tasks` | AI task orchestration |
| Templates | `/api/session-templates` | AI workflow configurations |
| Git | `/api/git-sources` | Repository management |
| Config | `/api/config-files` | Global and workspace config files |
| Auth | `/api/shared-auth` | OAuth token synchronization |
| Storage | `/api/storage`, `/api/binaries` | LVM and tool image management |
| Registry | `/api/registry` | Shared npm registry (Verdaccio) |
| SSH | `/api/ssh-keys` | User SSH key management |
| Events | `/api/events` | System-wide event stream |
| GitHub | `/api/github` | GitHub App integration |
| Images | `/api/images` | Base image listing |
| System | `/api/system/stats`, `/cleanup` | Monitoring and maintenance |

Full API documentation available at `/swagger` when the manager is running.
