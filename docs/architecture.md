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
| Database | **SQLite** (Drizzle ORM) | Sandbox and project state |

---

## Monorepo Structure

```
l-atelier/
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
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐  │
│  │ QUEUED  │───►│CREATING │───►│ RUNNING │───►│ STOPPED │───►│DESTROYED│  │
│  └─────────┘    └─────────┘    └────┬────┘    └─────────┘    └─────────┘  │
│                                     │                                       │
│  States:                                                                    │
│  • QUEUED    - Waiting for spawn slot                                       │
│  • CREATING  - VM booting, services starting                                │
│  • RUNNING   - Fully operational                                            │
│  • STOPPED   - VM paused, state preserved                                   │
│  • DESTROYED - Cleaned up, resources freed                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Prebuild Flow

```
Without Prebuilds (slow, ~2-5 minutes):
  Boot VM  →  Clone Repo  →  npm install  →  Ready

With Prebuilds (fast):

  One-time (background):
  Boot VM  →  Clone Repo  →  npm install  →  Snapshot

  Every spawn (instant):
  Clone Snapshot  →  Ready  (<200ms)
```

Prebuilds run expensive initialization (git clone, dependency install, build)
**once** and snapshot the result as an LVM thin volume. Subsequent sandboxes
clone from the snapshot instantly via copy-on-write.

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
│                         Caddy                                    │
│                                                                  │
│  Static Routes (Caddyfile):                                      │
│  ├── {DASHBOARD_DOMAIN}  → localhost:5173                        │
│  └── {API_DOMAIN}        → localhost:4000                        │
│                                                                  │
│  Dynamic Routes (Admin API, managed by Manager):                 │
│  ├── sandbox-{id}.{DOMAIN}  → 172.16.0.x:8080 (VSCode)         │
│  ├── opencode-{id}.{DOMAIN} → 172.16.0.x:3000 (OpenCode)       │
│  └── app-{id}-{port}.{DOMAIN} → 172.16.0.x:{port} (User apps)  │
│                                                                  │
│  Features:                                                       │
│  ├── Automatic HTTPS (Let's Encrypt)                             │
│  ├── Wildcard cert via DNS challenge                             │
│  └── Zero-downtime route updates via Admin API                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Firecracker VM Anatomy

```
┌─────────────────────────────────────────────────────────────────┐
│                    Firecracker MicroVM                           │
│                                                                  │
│  Resources (configurable per sandbox):                           │
│  ├── vCPUs: 1-8                                                  │
│  ├── RAM: 512MB - 8GB                                            │
│  └── Boot time: ~125ms                                           │
│                                                                  │
│  Storage:                                                        │
│  └── /dev/vda → LVM thin volume (CoW clone of base/prebuild)    │
│                                                                  │
│  Filesystem:                                                     │
│  /                                                               │
│  ├── usr/bin/                                                    │
│  │   ├── code-server        # VSCode Server                     │
│  │   ├── opencode           # OpenCode CLI                      │
│  │   ├── sandbox-agent      # In-VM agent binary                │
│  │   ├── node, bun, git     # Dev tools                         │
│  │   └── ...                                                    │
│  ├── home/dev/                                                   │
│  │   ├── workspace/         # Project code                      │
│  │   └── SANDBOX.md         # Agent skill file                  │
│  ├── etc/sandbox/                                                │
│  │   ├── config.json        # Sandbox metadata                  │
│  │   └── secrets/.env       # Injected secrets                  │
│  └── var/log/sandbox/       # Service logs                      │
│                                                                  │
│  Services (managed by sandbox-init):                             │
│  ├── sandbox-agent (:9999)  # Health, metrics, apps             │
│  ├── sshd (:22)             # SSH access                        │
│  ├── code-server (:8080)    # VSCode Server                     │
│  └── opencode serve (:3000) # OpenCode remote                   │
│                                                                  │
│  Network:                                                        │
│  └── eth0 → 172.16.0.x/24, gateway 172.16.0.1                   │
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
│                    LVM Thin Pool                                 │
│                    (sandbox-vg/thin-pool)                        │
│                                                                  │
│  Base Volumes (read-only templates):                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ base-rootfs (2GB)                                         │   │
│  │ Alpine + VSCode + OpenCode + tools                        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  Prebuild Volumes (per-project snapshots):                       │
│  ┌──────────────────────┐  ┌──────────────────────┐             │
│  │ prebuild-myproject   │  │ prebuild-backend     │             │
│  │ (clone of base +     │  │ (clone of base +     │             │
│  │  repo + node_modules)│  │  repo + deps)        │             │
│  └──────────────────────┘  └──────────────────────┘             │
│           │                          │                           │
│           │ instant clone            │ instant clone             │
│           ▼                          ▼                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ sandbox-abc │  │ sandbox-def │  │ sandbox-ghi │              │
│  │ (CoW, ~0 MB │  │ (CoW, ~0 MB │  │ (CoW, ~5 MB │             │
│  │  initial)   │  │  initial)   │  │  delta)     │              │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│                                                                  │
│  Only changed blocks are stored per sandbox!                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Sandbox Agent

A lightweight Rust binary running inside each VM.

```
┌─────────────────────────────────────────────────────────────────┐
│                      Sandbox Agent (:9999)                       │
│                                                                  │
│  Health Reporting:                                               │
│  ├── Service health checks (VSCode, OpenCode, SSH)              │
│  ├── Heartbeat to detect stuck sandboxes                        │
│  └── Report sandbox status to manager                           │
│                                                                  │
│  Resource Metrics:                                               │
│  ├── CPU, memory, disk usage                                    │
│  └── Exposed via /metrics endpoint                              │
│                                                                  │
│  Command Execution:                                              │
│  ├── /exec endpoint for running commands                        │
│  └── Interactive terminal via WebSocket (PTY)                   │
│                                                                  │
│  Dynamic App Registration:                                       │
│  ├── Detect new ports being listened on                         │
│  └── Request Caddy route from manager                           │
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
| Health | `GET /health`, `/health/live`, `/health/ready` | Liveness and readiness probes |
| Sandboxes | `GET/POST /api/sandboxes`, `DELETE /:id`, `POST /:id/stop`, `POST /:id/start` | Full sandbox lifecycle |
| Projects | `GET/POST /api/projects`, `PUT/DELETE /:id`, `POST /:id/prebuild` | Project CRUD and prebuilds |
| Images | `GET /api/images` | Base image listing |
| System | `GET /api/system/stats`, `/storage`, `/queue`, `POST /cleanup` | Monitoring and maintenance |

Full API documentation available at `/swagger` when the manager is running.
