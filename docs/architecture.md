# Architecture

> K8s + Kata Containers orchestrator built as a Bun monorepo

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
| Isolation | **Kata Containers** (Cloud Hypervisor) | VM-level sandbox isolation via K8s pods |
| Orchestration | **k3s** | Lightweight Kubernetes distribution |
| Storage | **TopoLVM** (CSI) | LVM thin provisioning, PVC snapshots |
| Reverse Proxy | **K8s Ingress** + **Caddy** (TLS termination) | Dynamic routing, HTTPS |
| Base Image Builds | **Kaniko** | Base OCI image builds inside K8s (triggered from dashboard) |
| Registry | **Zot** | Lightweight OCI registry for base images |
| Database | **SQLite** (Drizzle ORM) | Sandbox, workspace, task, config, and auth state |

---

## Monorepo Structure

```
atelier/
├── apps/
│   ├── manager/          # Sandbox orchestration API (ElysiaJS)
│   ├── dashboard/        # Admin web interface (React + Vite)
│   └── agent-rust/       # In-pod agent (Rust — lightweight, no AVX)
├── packages/
│   └── shared/           # Shared types, constants, errors
├── infra/
│   ├── images/           # Base image Dockerfiles
│   └── scripts/          # Install scripts
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
│  • CREATING - Pod booting, services starting                                │
│  • RUNNING  - Fully operational                                             │
│  • STOPPED  - Pod terminated, PVC preserved                                 │
│  • ERROR    - Failed to start or crashed                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Prebuild Flow

```
Without Prebuilds (slow, ~2-5 minutes):
  Boot Pod  →  Clone Repo  →  run workspace init commands  →  Ready

With Prebuilds (fast, ~1-3 seconds):

  One-time (background):
  Boot temp Pod + PVC  →  Clone Repo  →  run init commands  →  VolumeSnapshot

  Every spawn:
  PVC from VolumeSnapshot (CoW clone)  →  Boot Pod  →  Start Services  →  Ready
```

Prebuilds run expensive initialization (git clone, dependency install, build)
**once** and snapshot the PVC as a CSI VolumeSnapshot via TopoLVM. Subsequent
sandboxes clone from this snapshot instantly via copy-on-write and boot fresh.

---

## Network Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      k3s Cluster Network                        │
│                                                                 │
│  ┌──────────────┐                                               │
│  │   eth0       │◄── Public IP                                  │
│  │   (WAN)      │                                               │
│  └──────┬───────┘                                               │
│         │                                                       │
│         │ Caddy (TLS termination) → K8s Ingress                 │
│         │                                                       │
│  ┌──────▼───────┐                                               │
│  │  K8s Service │◄── 10.43.x.x (ClusterIP)                     │
│  │   + Ingress  │                                               │
│  └──────┬───────┘                                               │
│         │                                                       │
│    ┌────┴────┬────────┬────────┐                                │
│    │         │        │        │                                │
│ ┌──▼───┐ ┌──▼───┐ ┌──▼───┐ ┌──▼───┐                           │
│ │Pod 1 │ │Pod 2 │ │Pod 3 │ │Pod n │  Kata sandbox pods        │
│ │10.42 │ │10.42 │ │10.42 │ │10.42 │  (runtimeClass: kata-clh) │
│ └──────┘ └──────┘ └──────┘ └──────┘                            │
└─────────────────────────────────────────────────────────────────┘

External traffic:
  Internet → Caddy (:443) → K8s Ingress → Service → Pod:port
```

---

## K8s Ingress Routing

```
┌─────────────────────────────────────────────────────────────────┐
│                     K8s Ingress                                 │
│                                                                 │
│  Static Routes (Caddy, migrating to Ingress in Phase 3):       │
│  └── {DOMAIN}                                                   │
│      ├── /api/*, /auth/*, /config, /health, /swagger*           │
│      │   → manager.atelier-system.svc:4000                      │
│      └── * → Static Files (Dashboard SPA)                       │
│                                                                 │
│  Dynamic Routes (K8s Ingress, created by manager):              │
│  ├── sandbox-{id}.{DOMAIN}    → svc/sandbox-{id}:8080 (VSCode) │
│  ├── opencode-{id}.{DOMAIN}   → svc/sandbox-{id}:3000 (OC)     │
│  ├── dev-{name}-{id}.{DOMAIN} → svc/sandbox-{id}:{port} (Dev)  │
│  └── browser-{id}.{DOMAIN}    → svc/sandbox-{id}:7681 (Kasm)   │
│                                                                 │
│  Features:                                                      │
│  ├── TLS via Caddy (Phase 3: cert-manager or Traefik ACME)      │
│  └── Host-based routing via K8s Ingress resources               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Kata Sandbox Pod Anatomy

```
┌─────────────────────────────────────────────────────────────────┐
│                    Kata Sandbox Pod                              │
│                    (runtimeClassName: kata-clh)                  │
│                                                                 │
│  Resources (configurable per sandbox):                          │
│  ├── CPU: 500m-2000m (requests/limits)                          │
│  ├── RAM: 1Gi-4Gi (requests/limits)                             │
│  └── Boot time: ~1-2s (Cloud Hypervisor)                        │
│                                                                 │
│  Volumes:                                                       │
│  ├── workspace-pvc → /home/dev (CoW clone from VolumeSnapshot)  │
│  ├── shared-binaries-pvc → /opt/shared (ReadOnlyMany)           │
│  └── config-configmap → /etc/sandbox/config.json                │
│                                                                 │
│  Filesystem:                                                    │
│  /                                                              │
│  ├── usr/local/bin/                                             │
│  │   └── sandbox-agent      # In-pod agent binary               │
│  ├── opt/shared/bin/                                            │
│  │   ├── code-server        # VSCode Server                     │
│  │   ├── opencode           # OpenCode CLI                      │
│  │   └── node, bun, git     # Dev tools                         │
│  ├── home/dev/                                                  │
│  │   ├── workspace/         # Project code (on PVC)             │
│  │   └── SANDBOX.md         # Agent skill file                  │
│  ├── etc/sandbox/                                               │
│  │   ├── config.json        # Sandbox metadata (ConfigMap)      │
│  │   └── secrets/.env       # Injected secrets                  │
│  └── var/log/sandbox/       # Service logs                      │
│                                                                 │
│  Services:                                                      │
│  ├── sandbox-init starts sshd + sandbox-agent                   │
│  ├── agent starts services after manager pushes config:         │
│  │   ├── sandbox-agent (TCP:9998)                               │
│  │   ├── code-server (:8080)                                    │
│  │   ├── opencode serve (:3000)                                 │
│  │   ├── terminal (:7681)   # WebSocket PTY                     │
│  │   └── browser            # KasmVNC/Chromium on demand        │
│  └── sshd (:22)                                                 │
│                                                                 │
│  Network:                                                       │
│  └── Pod IP (10.42.x.x), routed via K8s CNI                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Storage Architecture

### PVC Snapshots via TopoLVM

| Approach | Snapshot Time | Space Efficiency | K8s Native |
|----------|---------------|------------------|------------|
| **TopoLVM Thin** | **<100ms** | **Excellent (CoW)** | **✅ CSI** |
| Longhorn | ~1s | Good | ✅ |
| OpenEBS | ~1s | Good | ✅ |

### Storage Layout

```
┌─────────────────────────────────────────────────────────────────┐
│                    TopoLVM Thin Pool                             │
│                    (LVM VG on each node)                         │
│                                                                 │
│  Base Images (in Zot registry, not on disk):                    │
│  ┌──────────────────────────┐  ┌──────────────────────────┐     │
│  │ dev-base:latest          │  │ dev-cloud:latest         │     │
│  │ Debian Bookworm + Node22 │  │ dev-base + Cloud SDKs    │     │
│  └──────────────────────────┘  └──────────────────────────┘     │
│                                                                 │
│  Prebuild VolumeSnapshots (per-workspace):                      │
│  ┌──────────────────────┐  ┌──────────────────────┐             │
│  │ prebuild-myproject   │  │ prebuild-backend     │             │
│  │ (snapshot of PVC +   │  │ (snapshot of PVC +   │             │
│  │  repo + init deps)   │  │  repo + init deps)   │             │
│  └──────────────────────┘  └──────────────────────┘             │
│           │                          │                          │
│           │ PVC from snapshot        │ PVC from snapshot        │
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

A lightweight Rust binary running inside each sandbox pod, communicating with
the manager via TCP on port 9998.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Sandbox Agent (TCP:9998)                      │
│                                                                 │
│  Core Responsibilities:                                         │
│  ├── TCP HTTP API for manager orchestration                     │
│  ├── Service & dev process lifecycle management                 │
│  ├── File system operations (writes, git helpers)               │
│  ├── Command execution (/exec)                                  │
│  ├── Interactive terminal sessions (WebSocket PTY)              │
│  └── Resource metrics (CPU, memory, disk)                       │
└─────────────────────────────────────────────────────────────────┘
```

**Why Rust?** Bun crashes inside Firecracker/Cloud Hypervisor VMs due to AVX
instruction issues (SIGILL). The agent is compiled as a static musl binary
for maximum compatibility.

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
| Config | `/api/config-files` | Global and workspace config files |
| Auth | `/api/shared-auth` | OAuth token synchronization |
| Storage | `/api/binaries` | Shared binaries management |
| Registry | `/api/registry` | Shared npm registry (Verdaccio) |
| SSH | `/api/ssh-keys` | User SSH key management |
| Events | `/api/events` | System-wide event stream |
| GitHub | `/api/github` | GitHub App integration |
| Images | `/api/images` | Base image listing and builds |
| System | `/api/system/stats` | Monitoring and maintenance |

Full API documentation available at `/swagger` when the manager is running.
