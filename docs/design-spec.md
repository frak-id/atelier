# L'atelier - Architecture & Tooling Specification v2

> A Bun monorepo-based sandbox orchestration system using Firecracker microVMs
> 
> Incorporating learnings from: Dust-Hive, Gitpod, Coder

## Current Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| **CLI** (`apps/cli`) | ✅ Complete | Full provisioning CLI with interactive prompts |
| **Manager API** (`apps/manager`) | ✅ Complete | Sandbox CRUD, projects, images, system stats, stop/start lifecycle |
| **Shared Types** (`packages/shared`) | ✅ Complete | Types for sandbox, project, system |
| **Deployment** (`scripts/deploy.ts`) | ✅ Complete | SSH-based deployment with systemd |
| **Dashboard** (`apps/dashboard`) | ✅ Complete | React + TanStack Router/Query, full sandbox/project management |
| **Sandbox Agent** (`apps/agent`) | ✅ Complete | Health, metrics, exec, services, apps (Node.js for FC compatibility) |
| **Projects** | ✅ Complete | Project CRUD with init/start commands, secrets, prebuilds |
| **Prebuilds** | ✅ Complete | LVM snapshot-based prebuilds with trigger API |
| **LVM Storage** | ✅ Complete | StorageService with auto-fallback to file copy |
| **Spawn Queue** | ✅ Complete | QueueService with concurrency control |
| **Sandbox Lifecycle** | ⚠️ Partial | Stop/Start (pause/resume) implemented; COLD state deferred |

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Technology Stack](#technology-stack)
3. [Core Concepts](#core-concepts)
4. [Monorepo Structure](#monorepo-structure)
5. [Server Infrastructure](#server-infrastructure)
6. [Storage Architecture](#storage-architecture)
7. [Sandbox Agent](#sandbox-agent)
8. [Prebuilds System](#prebuilds-system)
9. [Package Specifications](#package-specifications)
10. [Development Workflow](#development-workflow)
11. [Deployment Strategy](#deployment-strategy)
12. [Implementation Roadmap](#implementation-roadmap)
13. [Future Considerations](#future-considerations)

---

## Executive Summary

### What We're Building

A self-hosted platform for spinning up isolated development sandboxes with:
- **<200ms cold start** for pre-warmed VMs (after initial prebuild)
- **VSCode Server + OpenCode** pre-installed and ready
- **Project-based configuration** with git integration and secrets
- **Web dashboard** for sandbox management

### Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Isolation** | Firecracker microVMs | Hardware-level isolation, ~125ms boot, minimal overhead |
| **Storage** | LVM Thin Provisioning | Instant CoW snapshots, space-efficient |
| **Networking** | Caddy reverse proxy | Zero-reload API, auto HTTPS, simple |
| **Runtime** | Bun + TypeScript | Team expertise, fast, single binary |
| **Prebuilds** | Thin volume snapshots | Skip expensive init on every spawn |

### Learnings Applied

| Source | Key Insight | How We Use It |
|--------|-------------|---------------|
| **Dust-Hive** | Agent skill files | Inject `SANDBOX.md` into every sandbox |
| **Dust-Hive** | Git worktrees | Fast clones from cached bare repos |
| **Dust-Hive** | Cold/Warm states | Resource management without destroying |
| **Gitpod** | Prebuilds | Snapshot after init, restore instantly |
| **Gitpod** | Content service | Backup/restore sandbox state |
| **Coder** | Workspace Agent | Single binary for all sandbox services |
| **Coder** | Provisioner queue | Rate-limited, concurrent spawn jobs |
| **Coder** | WireGuard mesh | Future: direct IDE connections |

---

## Technology Stack

### Application Layer

| Component | Technology | Version | Purpose |
|-----------|------------|---------|---------|
| Runtime | **Bun** | 1.1+ | JS/TS runtime, bundler, package manager |
| Monorepo | **Bun Workspaces** | native | Workspace management |
| API Framework | **ElysiaJS** | 1.1+ | Type-safe HTTP server with Eden |
| Frontend Framework | **React** | 19+ | UI components |
| Frontend Router | **TanStack Router** | 1.0+ | Type-safe file-based routing |
| Frontend Build | **Vite** | 6+ | Dev server & bundling |
| Styling | **Tailwind CSS** | 4+ | Utility-first CSS |
| UI Components | **shadcn/ui** | latest | Accessible component primitives |
| State Management | **TanStack Query** | 5+ | Server state & caching |
| Validation | **TypeBox** | 0.34+ | Runtime validation (Elysia native) |

### Infrastructure Layer

| Component | Technology | Version | Purpose |
|-----------|------------|---------|---------|
| MicroVM | **Firecracker** | 1.6+ | Fast, secure VM isolation |
| Storage | **LVM Thin Provisioning** | native | CoW snapshots for fast clones |
| Reverse Proxy | **Caddy** | 2.8+ | Dynamic routing, auto HTTPS |
| Process Manager | **systemd** | native | Service lifecycle management |
| Container Build | **Docker** | 24+ | Rootfs image building only |
| OS | **Ubuntu Server** | 24.04 LTS | Host operating system |

### Development Tools

| Tool | Purpose |
|------|---------|
| **Biome** | Linting & formatting (faster than ESLint + Prettier) |
| **Lefthook** | Git hooks management |

---

## Core Concepts

### Sandbox Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Sandbox Lifecycle                                   │
│                                                                             │
│  ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐  │
│  │ QUEUED  │───►│CREATING │───►│ RUNNING │───►│ STOPPED │───►│DESTROYED│  │
│  └─────────┘    └─────────┘    └────┬────┘    └────┬────┘    └─────────┘  │
│                                     │              │                       │
│                                     │   ┌─────────┐│                       │
│                                     └──►│  COLD   │◄┘                       │
│                                         └─────────┘                         │
│                                                                             │
│  States:                                                                    │
│  • QUEUED    - Waiting for spawn slot                                      │
│  • CREATING  - VM booting, services starting                               │
│  • RUNNING   - Fully operational (warm)                                    │
│  • COLD      - Minimal services, reduced resources                         │
│  • STOPPED   - VM paused, state preserved                                  │
│  • DESTROYED - Cleaned up, resources freed                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Prebuild Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Prebuild System                                   │
│                                                                             │
│  Without Prebuilds (slow):                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐                   │
│  │ Boot VM  │─►│Clone Repo│─►│npm install│─►│  Ready   │  ~2-5 minutes    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘                   │
│                                                                             │
│  With Prebuilds (fast):                                                     │
│                                                                             │
│  One-time (background):                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐                   │
│  │ Boot VM  │─►│Clone Repo│─►│npm install│─►│ Snapshot │                   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘                   │
│                                                                             │
│  Every spawn (instant):                                                     │
│  ┌──────────────────┐  ┌──────────┐                                        │
│  │ Clone Snapshot   │─►│  Ready   │  <200ms                                │
│  └──────────────────┘  └──────────┘                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Agent Skill Pattern

Every sandbox includes a `SANDBOX.md` file that teaches coding agents about the environment:

```markdown
# Sandbox Environment: {{SANDBOX_ID}}

## Project: {{PROJECT_NAME}}
## Branch: {{BRANCH}}
## Created: {{CREATED_AT}}

## Available Services
- VSCode Server: http://localhost:8080
- OpenCode Server: http://localhost:3000
- SSH: Available on port 22

## Commands
- `sandbox-status` - Check all services
- `sandbox-logs <service>` - View service logs
- `sandbox-restart <service>` - Restart a service

## Project-Specific Setup
{{PROJECT_INIT_INSTRUCTIONS}}

## Environment Variables
Secrets are available in `/etc/sandbox/secrets/.env`
Source with: `source /etc/sandbox/secrets/.env`

## Troubleshooting
- If services aren't responding, run `sandbox-status`
- Logs are in `/var/log/sandbox/`
- Network issues? Check `ip addr` and `ping 172.16.0.1`
```

---

## Monorepo Structure (Current)

```
oc-sandbox/
├── apps/
│   ├── manager/                   # ✅ Sandbox orchestration API (ElysiaJS)
│   │   ├── src/
│   │   │   ├── index.ts           # Elysia app entry with Swagger
│   │   │   ├── routes/
│   │   │   │   ├── sandboxes/     # /api/sandboxes/* (CRUD + stop/start)
│   │   │   │   │   ├── index.ts   # List, create, get, delete, stop, start
│   │   │   │   │   └── model.ts   # TypeBox schemas
│   │   │   │   ├── projects/      # /api/projects/* (CRUD + prebuilds)
│   │   │   │   ├── images/        # /api/images/* (base images)
│   │   │   │   ├── system/        # /api/system/* (stats, cleanup)
│   │   │   │   │   ├── index.ts
│   │   │   │   │   └── service.ts
│   │   │   │   ├── health.ts      # /health, /health/live, /health/ready
│   │   │   │   └── debug/         # /debug/* (development)
│   │   │   ├── services/
│   │   │   │   ├── firecracker.ts       # ✅ VM lifecycle (spawn, destroy, stop, start)
│   │   │   │   ├── firecracker-client.ts # ✅ Firecracker API client (pause/resume)
│   │   │   │   ├── network.ts           # ✅ TAP device & IP allocation
│   │   │   │   ├── caddy.ts             # ✅ Dynamic route registration
│   │   │   │   ├── storage.ts           # ✅ LVM thin provisioning (CoW snapshots)
│   │   │   │   ├── queue.ts             # ✅ Spawn job queue with concurrency
│   │   │   │   ├── project.ts           # ✅ Project management
│   │   │   │   ├── agent.ts             # ✅ Sandbox agent client
│   │   │   │   └── secrets.ts           # ✅ Secret encryption
│   │   │   ├── lib/
│   │   │   │   ├── shell.ts       # Shell command execution
│   │   │   │   ├── config.ts      # Environment configuration
│   │   │   │   ├── logger.ts      # Structured logging (pino)
│   │   │   │   └── errors.ts      # Custom error classes
│   │   │   └── state/
│   │   │       ├── store.ts       # In-memory sandbox state
│   │   │       └── database.ts    # SQLite persistence
│   │   ├── dist/
│   │   │   └── server.js          # Built bundle for deployment
│   │   └── package.json
│   │
│   └── dashboard/                 # ✅ Admin web interface (React + Vite)
│       ├── src/
│       │   ├── main.tsx           # App entry with TanStack Query + Router
│       │   ├── routes/
│       │   │   ├── __root.tsx     # Root layout with sidebar navigation
│       │   │   ├── index.tsx      # Dashboard overview (health, stats)
│       │   │   ├── sandboxes/
│       │   │   │   ├── index.tsx  # Sandbox list with stop/start/delete
│       │   │   │   └── $id.tsx    # Sandbox detail (URLs, metrics, exec)
│       │   │   ├── projects/
│       │   │   │   ├── index.tsx  # Project list
│       │   │   │   └── $id.tsx    # Project detail + prebuild trigger
│       │   │   ├── images/
│       │   │   │   └── index.tsx  # Base images list
│       │   │   └── system/
│       │   │       └── index.tsx  # System stats, queue, cleanup
│       │   ├── api/
│       │   │   ├── client.ts      # REST API client with types
│       │   │   └── queries.ts     # TanStack Query hooks
│       │   ├── components/
│       │   │   ├── ui/            # shadcn/ui components
│       │   │   ├── create-sandbox-dialog.tsx
│       │   │   ├── create-project-dialog.tsx
│       │   │   └── edit-project-dialog.tsx
│       │   └── lib/
│       │       └── utils.ts       # formatBytes, formatDate, etc.
│       ├── dist/                  # Built static files
│       └── package.json
│
├── packages/
│   ├── shared/                    # ✅ Shared types & constants
│   │   ├── src/
│   │   │   ├── types/
│   │   │   │   ├── sandbox.ts     # Sandbox, SandboxStatus, CreateSandboxOptions
│   │   │   │   ├── project.ts     # Project, CreateProjectOptions
│   │   │   │   ├── system.ts      # SystemStats, HealthStatus
│   │   │   │   └── index.ts       # Re-exports
│   │   │   ├── constants.ts       # PATHS, FIRECRACKER, NETWORK, LVM, CADDY, DEFAULTS
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── agent/                     # ✅ In-VM agent (Node.js - Bun crashes in FC)
│   │   ├── src/
│   │   │   ├── index.ts           # Elysia server on :9999
│   │   │   └── routes/
│   │   │       ├── health.ts      # /health - service status
│   │   │       ├── metrics.ts     # /metrics - CPU/memory/disk
│   │   │       ├── exec.ts        # /exec - run commands
│   │   │       ├── services.ts    # /services - systemd status
│   │   │       └── apps.ts        # /apps - port registration
│   │   ├── dist/
│   │   │   └── sandbox-agent.mjs  # Built with --target=node
│   │   └── package.json
│   │
│   └── cli/                       # ✅ Server provisioning CLI
│       ├── src/
│       │   ├── index.ts           # Entry point with @clack/prompts
│       │   └── commands/
│       │       ├── base-setup.ts
│       │       ├── install-firecracker.ts
│       │       ├── setup-network.ts
│       │       ├── setup-storage.ts
│       │       ├── deploy-manager.ts
│       │       └── test-vm.ts
│       ├── dist/
│       │   └── atelier-linux-x64
│       └── package.json
│
├── infra/
│   ├── caddy/
│   │   └── Caddyfile              # ✅ Static routes (API + dashboard)
│   ├── images/                    # ✅ Rootfs Dockerfiles
│   │   ├── dev-base/Dockerfile    # Alpine + Node + Bun + code-server + opencode
│   │   └── ...
│   └── systemd/
│       ├── atelier-manager.service
│       └── atelier-network.service
│
├── scripts/
│   └── deploy.ts                  # ✅ SSH deployment (manager + agent + dashboard)
│
├── .env.example
├── package.json
├── tsconfig.json
├── bun.lock
├── PROJECT.md                     # This file
└── AGENTS.md                      # Development guide for AI agents
```

---

## Server Infrastructure

### Hardware Requirements

**Recommended: Hetzner AX52** (€77/month)

| Spec | Value | Notes |
|------|-------|-------|
| CPU | AMD Ryzen 7 7700 | 8 cores / 16 threads |
| RAM | 64 GB DDR5 | ~20 sandboxes @ 2GB each |
| Storage | 1 TB NVMe | LVM thin pool for snapshots |
| Network | 1 Gbps | Sufficient for dev workloads |
| KVM | ✅ Required | Firecracker needs /dev/kvm |

### Network Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Host Network                             │
│                                                                 │
│  ┌──────────────┐                                               │
│  │   eth0       │◄─── Public IP                                │
│  │   (WAN)      │                                               │
│  └──────┬───────┘                                               │
│         │                                                       │
│         │ NAT (iptables MASQUERADE)                             │
│         │                                                       │
│  ┌──────▼───────┐                                               │
│  │    br0       │◄─── 172.16.0.1/24 (Bridge)                   │
│  │  (Bridge)    │                                               │
│  └──────┬───────┘                                               │
│         │                                                       │
│    ┌────┴────┬────────┬────────┐                               │
│    │         │        │        │                               │
│ ┌──▼──┐  ┌──▼──┐  ┌──▼──┐  ┌──▼──┐                           │
│ │tap-1│  │tap-2│  │tap-3│  │tap-n│  TAP devices              │
│ └──┬──┘  └──┬──┘  └──┬──┘  └──┬──┘                           │
│    │        │        │        │                                │
│ ┌──▼──┐  ┌──▼──┐  ┌──▼──┐  ┌──▼──┐                           │
│ │VM 1 │  │VM 2 │  │VM 3 │  │VM n │  Firecracker VMs          │
│ │.10  │  │.11  │  │.12  │  │.x   │  172.16.0.x               │
│ └─────┘  └─────┘  └─────┘  └─────┘                           │
└─────────────────────────────────────────────────────────────────┘

External Traffic Flow:
  Internet → Caddy (:443) → br0 → tap-x → VM:port
```

### Caddy Configuration

```
┌─────────────────────────────────────────────────────────────────┐
│                         Caddy                                   │
│                                                                 │
│  Static Routes (Caddyfile):                                     │
│  ├── dashboard.sandbox.frak.dev → localhost:3000               │
│  └── api.sandbox.frak.dev → localhost:4000                     │
│                                                                 │
│  Dynamic Routes (Admin API):                                    │
│  ├── sandbox-{id}.sandbox.frak.dev → 172.16.0.x:8080 (VSCode) │
│  ├── opencode-{id}.sandbox.frak.dev → 172.16.0.x:3000 (OC)    │
│  └── app-{id}-{port}.sandbox.frak.dev → 172.16.0.x:{port}     │
│                                                                 │
│  Features:                                                      │
│  ├── Automatic HTTPS (Let's Encrypt)                           │
│  ├── Wildcard cert for *.sandbox.frak.dev (DNS challenge)     │
│  └── Zero-downtime route updates via Admin API                 │
└─────────────────────────────────────────────────────────────────┘
```

### Firecracker VM Anatomy

```
┌─────────────────────────────────────────────────────────────────┐
│                    Firecracker MicroVM                          │
│                                                                 │
│  Resources (configurable per sandbox):                          │
│  ├── vCPUs: 1-8                                                │
│  ├── RAM: 512MB - 8GB                                          │
│  └── Boot time: ~125ms                                         │
│                                                                 │
│  Storage:                                                       │
│  └── /dev/vda ──► LVM thin volume (CoW clone of base/prebuild)│
│                                                                 │
│  Filesystem:                                                    │
│  /                                                              │
│  ├── usr/bin/                                                  │
│  │   ├── code-server        # VSCode Server                    │
│  │   ├── opencode           # OpenCode CLI                     │
│  │   ├── sandbox-agent      # Frak agent binary                │
│  │   ├── node, bun, git     # Dev tools                        │
│  │   └── ...                                                   │
│  ├── home/dev/                                                 │
│  │   ├── workspace/         # Project code                     │
│  │   └── SANDBOX.md         # Agent skill file                 │
│  ├── etc/sandbox/                                              │
│  │   ├── config.json        # Sandbox metadata                 │
│  │   └── secrets/.env       # Injected secrets                 │
│  └── var/log/sandbox/       # Service logs                     │
│                                                                 │
│  Services (managed by sandbox-init):                           │
│  ├── sandbox-agent (:9999)  # Health, metrics, apps            │
│  ├── sshd (:22)             # SSH access                       │
│  ├── code-server (:8080)    # VSCode Server                    │
│  └── opencode serve (:3000) # OpenCode remote                  │
│                                                                 │
│  Network:                                                       │
│  └── eth0 → 172.16.0.x/24, gateway 172.16.0.1                 │
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

We use **LVM Thin Provisioning** for instant copy-on-write snapshots.

### Storage Layout

```
┌─────────────────────────────────────────────────────────────────┐
│                    LVM Thin Pool                                │
│                    (sandbox-vg/thin-pool)                       │
│                                                                 │
│  Base Volumes (read-only templates):                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ base-rootfs (2GB)                                        │   │
│  │ Alpine + VSCode + OpenCode + tools                       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Prebuild Volumes (per-project snapshots):                      │
│  ┌─────────────────────┐  ┌─────────────────────┐              │
│  │ prebuild-wallet     │  │ prebuild-backend    │              │
│  │ (clone of base +    │  │ (clone of base +    │              │
│  │  repo + node_modules)│  │  repo + deps)       │              │
│  └─────────────────────┘  └─────────────────────┘              │
│           │                        │                            │
│           │ instant clone          │ instant clone              │
│           ▼                        ▼                            │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ sandbox-abc │  │ sandbox-def │  │ sandbox-ghi │             │
│  │ (CoW, ~0 MB │  │ (CoW, ~0 MB │  │ (CoW, ~5 MB │             │
│  │  initial)   │  │  initial)   │  │  delta)     │             │
│  └─────────────┘  └─────────────┘  └─────────────┘             │
│                                                                 │
│  Only changed blocks are stored per sandbox!                    │
└─────────────────────────────────────────────────────────────────┘
```

### Storage Service API

```typescript
// services/storage.ts

interface StorageService {
  // Base operations
  createVolume(name: string, sizeGb: number): Promise<string>;
  deleteVolume(name: string): Promise<void>;
  
  // Snapshot operations (instant!)
  snapshot(source: string, target: string): Promise<string>;
  cloneFromBase(sandboxId: string): Promise<string>;
  cloneFromPrebuild(projectId: string, sandboxId: string): Promise<string>;
  
  // Prebuild management
  createPrebuild(projectId: string, sandboxId: string): Promise<void>;
  getPrebuild(projectId: string): Promise<string | null>;
  deletePrebuild(projectId: string): Promise<void>;
  
  // Stats
  getVolumeStats(name: string): Promise<{ used: number; size: number }>;
  getPoolStats(): Promise<{ used: number; size: number; volumes: number }>;
}
```

### Implementation

```typescript
// services/storage.ts
import { $ } from "bun";

const VG_NAME = "sandbox-vg";
const POOL_NAME = "thin-pool";
const BASE_VOLUME = "base-rootfs";

export const storage = {
  /**
   * Create instant CoW snapshot (< 5ms)
   */
  async cloneFromPrebuild(projectId: string, sandboxId: string): Promise<string> {
    const prebuildVolume = `prebuild-${projectId}`;
    const sandboxVolume = `sandbox-${sandboxId}`;
    
    // Check if prebuild exists
    const hasPrebuild = await this.volumeExists(prebuildVolume);
    const source = hasPrebuild ? prebuildVolume : BASE_VOLUME;
    
    // Instant snapshot
    await $`lvcreate -s -n ${sandboxVolume} ${VG_NAME}/${source}`.quiet();
    
    return `/dev/${VG_NAME}/${sandboxVolume}`;
  },

  async deleteVolume(sandboxId: string): Promise<void> {
    await $`lvremove -f ${VG_NAME}/sandbox-${sandboxId}`.quiet();
  },

  async createPrebuild(projectId: string, sandboxId: string): Promise<void> {
    const sandboxVolume = `sandbox-${sandboxId}`;
    const prebuildVolume = `prebuild-${projectId}`;
    
    // Delete old prebuild if exists
    if (await this.volumeExists(prebuildVolume)) {
      await $`lvremove -f ${VG_NAME}/${prebuildVolume}`.quiet();
    }
    
    // Snapshot current sandbox as new prebuild
    await $`lvcreate -s -n ${prebuildVolume} ${VG_NAME}/${sandboxVolume}`.quiet();
  },

  async volumeExists(name: string): Promise<boolean> {
    const result = await $`lvs ${VG_NAME}/${name}`.quiet().nothrow();
    return result.exitCode === 0;
  },
};
```

---

## Sandbox Agent

A lightweight binary that runs inside each sandbox VM, providing:

### Responsibilities

```
┌─────────────────────────────────────────────────────────────────┐
│                      Sandbox Agent                              │
│                                                                 │
│  Health Reporting:                                              │
│  ├── Report sandbox status to manager                          │
│  ├── Service health checks (VSCode, OpenCode, SSH)             │
│  └── Heartbeat to detect stuck sandboxes                       │
│                                                                 │
│  Resource Metrics:                                              │
│  ├── CPU usage                                                 │
│  ├── Memory usage                                              │
│  └── Disk usage                                                │
│                                                                 │
│  Dynamic App Registration:                                      │
│  ├── Detect new ports being listened on                        │
│  ├── Request Caddy route from manager                          │
│  └── Provide app URLs to user                                  │
│                                                                 │
│  Manager Communication:                                         │
│  └── HTTP API on :9999 for manager to query/control            │
└─────────────────────────────────────────────────────────────────┘
```

### Agent API

```typescript
// apps/agent/src/index.ts

// Runs inside the VM, exposed on port 9999

const app = new Elysia()
  .get("/health", () => ({
    status: "healthy",
    services: {
      vscode: checkPort(8080),
      opencode: checkPort(3000),
      ssh: checkPort(22),
    },
    uptime: process.uptime(),
  }))
  
  .get("/metrics", () => ({
    cpu: getCpuUsage(),
    memory: getMemoryUsage(),
    disk: getDiskUsage(),
  }))
  
  .get("/apps", () => getRegisteredApps())
  
  .post("/apps", ({ body }) => registerApp(body))
  
  .post("/exec", async ({ body }) => {
    // Execute command in sandbox (for manager)
    const result = await $`${body.command}`.quiet().nothrow();
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  })
  
  .listen(9999);
```

### Agent Skill File Generation

```typescript
// services/sandbox.ts

function generateSkillFile(sandbox: Sandbox, project: Project): string {
  return `# Sandbox Environment: ${sandbox.id}

## Project: ${project.name}
## Branch: ${sandbox.branch}
## Created: ${sandbox.createdAt}

## Available Services
| Service | URL | Port |
|---------|-----|------|
| VSCode Server | ${sandbox.urls.vscode} | 8080 |
| OpenCode Server | ${sandbox.urls.opencode} | 3000 |
| SSH | \`ssh dev@${sandbox.ipAddress}\` | 22 |

## Quick Commands
\`\`\`bash
# Check service status
sandbox-status

# View logs
sandbox-logs vscode
sandbox-logs opencode

# Restart a service
sandbox-restart vscode
\`\`\`

## Project Setup
${project.initInstructions || 'No special setup required.'}

## Environment Variables
Secrets are loaded from \`/etc/sandbox/secrets/.env\`

## Git Configuration
- Remote: ${project.gitUrl}
- Branch: ${sandbox.branch}
- Workspace: /home/dev/workspace

## Troubleshooting
- Services not responding? Run \`sandbox-status\`
- Need to restart? Run \`sandbox-restart <service>\`
- Network issues? Check \`ping 172.16.0.1\`
`;
}
```

---

## Prebuilds System

### Concept

Prebuilds run expensive initialization (git clone, npm install, build) **once** and snapshot the result. Subsequent sandboxes clone from the snapshot instantly.

### Prebuild Triggers

```typescript
// When to create/update prebuilds:

// 1. Manual trigger via API
POST /api/projects/:id/prebuild

// 2. On project creation (optional)
POST /api/projects
{ "name": "wallet", "gitUrl": "...", "autoPrebuild": true }

// 3. Webhook on git push (future)
POST /api/webhooks/github
{ "ref": "refs/heads/main", "repository": { "full_name": "frak-id/wallet" } }
```

### Prebuild Flow

```typescript
// services/prebuild.ts

interface PrebuildService {
  create(projectId: string): Promise<Prebuild>;
  getStatus(prebuildId: string): Promise<PrebuildStatus>;
  getLatest(projectId: string): Promise<Prebuild | null>;
}

async function createPrebuild(projectId: string): Promise<Prebuild> {
  const project = await getProject(projectId);
  const prebuildId = nanoid(8);
  
  // 1. Spawn temporary sandbox from base
  const sandbox = await spawnSandbox({
    projectId,
    sandboxId: `prebuild-${prebuildId}`,
    fromBase: true,  // Don't use existing prebuild
  });
  
  // 2. Run init commands
  for (const cmd of project.initCommands) {
    await execInSandbox(sandbox.id, cmd);
  }
  
  // 3. Snapshot as new prebuild
  await storage.createPrebuild(projectId, sandbox.id);
  
  // 4. Cleanup temporary sandbox
  await destroySandbox(sandbox.id);
  
  return {
    id: prebuildId,
    projectId,
    status: 'ready',
    createdAt: new Date().toISOString(),
  };
}
```

### Project Configuration

```typescript
// types/project.ts

interface Project {
  id: string;
  name: string;
  gitUrl: string;
  defaultBranch: string;
  
  // Prebuild configuration
  initCommands: string[];        // Run during prebuild
  
  // Dev commands (user-triggered processes)
  devCommands?: DevCommand[];    // Interactive dev processes (start/stop via dashboard)
  
  // Resource defaults
  defaultVcpus: number;
  defaultMemoryMb: number;
  
  // Secrets
  secrets: Record<string, string>;
  
  // Metadata
  latestPrebuildId?: string;
  prebuildStatus?: 'none' | 'building' | 'ready' | 'failed';
  createdAt: string;
  updatedAt: string;
}

interface DevCommand {
  name: string;                  // URL-safe identifier (e.g. "dev-server")
  command: string;               // Command to run (e.g. "bun run dev")
  port?: number;                 // Port to expose via Caddy
  workdir?: string;              // Working directory
  env?: Record<string, string>;  // Additional env vars
  isDefault?: boolean;           // Default command gets simplified URL
}

// Example project
const walletProject: Project = {
  id: "wallet",
  name: "Frak Wallet",
  gitUrl: "https://github.com/frak-id/wallet.git",
  defaultBranch: "main",
  
  initCommands: [
    "cd /home/dev/workspace && bun install",
    "cd /home/dev/workspace && bun run build",
  ],
  devCommands: [
    { name: "dev-server", command: "bun run dev", port: 3000, isDefault: true },
  ],
  
  defaultVcpus: 2,
  defaultMemoryMb: 4096,
  
  secrets: {
    ANTHROPIC_API_KEY: "sk-ant-...",
    DATABASE_URL: "postgres://...",
  },
  
  latestPrebuildId: "abc123",
  prebuildStatus: "ready",
  createdAt: "2025-01-15T10:00:00Z",
  updatedAt: "2025-01-15T12:00:00Z",
};
```

---

## Package Specifications

### `apps/cli` ✅ IMPLEMENTED

**Purpose**: Server provisioning and management CLI. Interactive prompts via `@clack/prompts`.

**Package**: `@frak/atelier-cli`

**Dependencies**:
```json
{
  "dependencies": {
    "@clack/prompts": "^0.10.0",
    "@frak/atelier-shared": "workspace:*"
  }
}
```

**Commands**:
| Command | Subcommands | Description |
|---------|-------------|-------------|
| `init` | - | Full install (config + setup + update + images) |
| `base` | - | Install Bun, Docker, Caddy, verify KVM |
| `firecracker` | - | Download Firecracker binary, kernel, rootfs |
| `network` | - | Configure persistent br0 bridge with NAT |
| `storage` | - | Setup LVM thin pool for CoW snapshots |
| `manager` | `start`, `stop`, `restart`, `status`, `logs` | Manage the API service |
| `debug-vm` | `start`, `stop`, `status`, `ssh` | Test VM operations |

**Build**:
```bash
bun build src/index.ts --compile --target=bun-linux-x64 --outfile dist/atelier-linux-x64
```

---

### `apps/manager` ✅ IMPLEMENTED

**Purpose**: Backend API orchestrating Firecracker VMs and system resources.

**Package**: `@frak/atelier-manager`

**Dependencies**:
```json
{
  "dependencies": {
    "elysia": "^1.2.0",
    "@elysiajs/cors": "^1.2.0",
    "@elysiajs/swagger": "^1.2.0",
    "@frak/atelier-shared": "workspace:*",
    "pino": "^9.0.0",
    "nanoid": "^5.0.0"
  }
}
```

**Current API Endpoints**:
```
Health:
  GET  /                              → API info & swagger link
  GET  /health                        → Full health status (incl. LVM check)
  GET  /health/live                   → Liveness probe
  GET  /health/ready                  → Readiness probe

Sandboxes (✅ complete):
  GET    /api/sandboxes               → List all sandboxes (filter by status, projectId)
  POST   /api/sandboxes               → Create sandbox (sync or async via ?async=true)
  GET    /api/sandboxes/:id           → Get sandbox details
  DELETE /api/sandboxes/:id           → Destroy sandbox
  POST   /api/sandboxes/:id/stop      → Stop (pause) sandbox
  POST   /api/sandboxes/:id/start     → Start (resume) sandbox
  GET    /api/sandboxes/job/:id       → Get spawn job status
  GET    /api/sandboxes/:id/health    → Agent health (via sandbox-agent)
  GET    /api/sandboxes/:id/metrics   → Resource metrics (via sandbox-agent)
  GET    /api/sandboxes/:id/services  → Service status (via sandbox-agent)
  POST   /api/sandboxes/:id/exec      → Execute command (via sandbox-agent)
  GET    /api/sandboxes/:id/apps      → List registered apps
  POST   /api/sandboxes/:id/apps      → Register app port
  GET    /api/sandboxes/:id/logs/:svc → Get service logs

Projects (✅ complete):
  GET    /api/projects                → List all projects
  POST   /api/projects                → Create project
  GET    /api/projects/:id            → Get project details
  PUT    /api/projects/:id            → Update project
  DELETE /api/projects/:id            → Delete project
  POST   /api/projects/:id/prebuild   → Trigger prebuild

Images (✅ complete):
  GET    /api/images                  → List base images
  GET    /api/images/:id              → Get image details

System (✅ complete):
  GET    /api/system/stats            → Resource usage (CPU, memory, disk)
  GET    /api/system/storage          → LVM pool stats and availability
  GET    /api/system/queue            → Spawn queue status and jobs
  POST   /api/system/cleanup          → Cleanup orphaned resources

Debug (development only):
  GET    /debug/config                → Current config
  GET    /debug/firecracker/:id       → Firecracker state

Deferred:
  POST   /api/sandboxes/:id/warm      → Warm up (requires COLD state)
  POST   /api/sandboxes/:id/cold      → Cool down (requires vCPU hot-plug)
```

**Implemented Services**:
```
services/
├── firecracker.ts         # ✅ spawn(), destroy(), getStatus(), stop(), start()
├── firecracker-client.ts  # ✅ Firecracker API: pause(), resume(), getVmState()
├── network.ts             # ✅ allocate(), release(), createTap(), deleteTap()
├── caddy.ts               # ✅ registerRoutes(), removeRoutes()
├── storage.ts             # ✅ createSandboxVolume(), deleteSandboxVolume(), getPoolStats()
├── queue.ts               # ✅ enqueue(), enqueueAndWait(), getStats(), cancel()
├── project.ts             # ✅ create(), update(), delete(), getAll(), getById()
├── agent.ts               # ✅ Client for sandbox-agent API (health, metrics, exec, etc.)
├── secrets.ts             # ✅ encrypt(), decrypt() for project secrets
└── sandbox-builder.ts     # ✅ Full sandbox build pipeline (LVM, network, git, init)
```

---

### `packages/shared` ✅ IMPLEMENTED

**Purpose**: Shared types and constants used by CLI and Manager.

**Package**: `@frak/atelier-shared`

**Exports**:
```typescript
// types/sandbox.ts
export type SandboxStatus = "creating" | "running" | "stopped" | "error";

export interface Sandbox {
  id: string;
  status: SandboxStatus;
  projectId?: string;
  branch?: string;
  ipAddress: string;
  macAddress: string;
  urls: { vscode: string; opencode: string; ssh: string };
  resources: { vcpus: number; memoryMb: number };
  pid?: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface CreateSandboxOptions {
  id?: string;
  projectId?: string;
  branch?: string;
  vcpus?: number;
  memoryMb?: number;
}

// constants.ts
export const PATHS = {
  SANDBOX_DIR: "/var/lib/sandbox",
  KERNEL_DIR: "/var/lib/sandbox/firecracker/kernels",
  ROOTFS_DIR: "/var/lib/sandbox/firecracker/rootfs",
  OVERLAY_DIR: "/var/lib/sandbox/overlays",
  SOCKET_DIR: "/var/lib/sandbox/sockets",
  LOG_DIR: "/var/log/sandbox",
  APP_DIR: "/opt/atelier",
} as const;

export const FIRECRACKER = {
  VERSION: "1.10.1",
  BINARY_PATH: "/usr/local/bin/firecracker",
} as const;

export const NETWORK = {
  BRIDGE_NAME: "br0",
  BRIDGE_IP: "172.16.0.1",
  BRIDGE_CIDR: "172.16.0.0/24",
  GUEST_IP_START: 10,
  GUEST_SUBNET: "172.16.0",
} as const;

export const DEFAULTS = {
  VCPUS: 2,
  MEMORY_MB: 2048,
  MAX_SANDBOXES: 20,
} as const;
```

---

### `apps/dashboard` ✅ IMPLEMENTED

**Purpose**: Admin web interface for managing sandboxes, projects, and images.

**Status**: Complete. Deployed at https://sandbox-dash.nivelais.com/

**Package**: `@frak/atelier-dashboard`

**Dependencies**:
```json
{
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@tanstack/react-router": "^1.93.0",
    "@tanstack/react-query": "^5.62.0",
    "lucide-react": "^0.468.0",
    "tailwind-merge": "^2.5.0",
    "clsx": "^2.1.0"
  },
  "devDependencies": {
    "@tanstack/router-plugin": "^1.93.0",
    "@vitejs/plugin-react": "^4.3.0",
    "tailwindcss": "^4.0.0",
    "vite": "^6.4.0"
  }
}
```

**Route Structure**:
```
/                       → Dashboard overview (health, stats, storage)
/sandboxes              → List all sandboxes (filter by status)
/sandboxes/:id          → Sandbox detail (URLs, metrics, services, exec)
/projects               → List all projects (with prebuild status)
/projects/:id           → Project detail (config, spawn sandbox, trigger prebuild)
/images                 → List base images
/system                 → System settings (stats, queue, cleanup)
```

**Key Components**:
- `CreateSandboxDialog` - Create sandbox from base image or project
- `CreateProjectDialog` - Create new project with git URL, commands, secrets
- `EditProjectDialog` - Edit existing project configuration

**Features**:
- Stop/Start sandbox (Firecracker pause/resume)
- Delete sandbox
- Recreate sandbox from project (for error recovery)
- Trigger prebuild for project
- Execute commands in sandbox (terminal tab)
- Real-time metrics and service status

---

### `apps/agent` ✅ IMPLEMENTED

**Purpose**: Lightweight binary running inside each VM for health reporting, metrics, and app registration.

**Status**: Complete. Runs on port 9999 inside each sandbox.

**Package**: `@frak/atelier-agent`

**IMPORTANT**: Built with `--target=node` (NOT bun) because Bun crashes with SIGILL inside Firecracker due to AVX instruction issues.

**Build**:
```bash
bun build --bundle --target=node --outfile=dist/sandbox-agent.mjs src/index.ts
```

**API Endpoints** (on :9999 inside VM):
```
GET  /health     → Service status (code-server, opencode, sshd)
GET  /metrics    → CPU, memory, disk usage
POST /exec       → Execute command { command: string, timeout?: number }
GET  /services   → Systemd service status
GET  /apps       → List registered app ports
POST /apps       → Register app port { port: number, name: string }
DELETE /apps/:port → Unregister app port
GET  /logs/:service → Get service logs
```

**Dependencies**:
```json
{
  "dependencies": {
    "elysia": "^1.2.0"
  }
}
```

---

## Development Workflow

### Local Development

```bash
# 1. Clone and install
git clone https://github.com/frak-id/oc-sandbox.git
cd oc-sandbox
bun install

# 2. Start manager in mock mode (no Firecracker needed)
cd apps/manager
SANDBOX_MODE=mock bun run dev
# → http://localhost:4000
# → Swagger: http://localhost:4000/swagger

# 3. Test the API
curl http://localhost:4000/health
curl -X POST http://localhost:4000/api/sandboxes -H "Content-Type: application/json" -d '{}'
curl http://localhost:4000/api/sandboxes
```

### Deployment to Server

```bash
# 1. Configure SSH credentials in .env
cp .env.example .env
# Edit: SSH_KEY_PATH, SSH_USER, SSH_HOST

# 2. Build and deploy
bun run deploy
# This will:
#   - Build CLI binary for Linux
#   - Build manager server.js bundle
#   - SCP files to server
#   - Install systemd services
#   - Restart manager
```

### Mock Mode

The manager supports mock mode for local development without Firecracker:

```typescript
// Set via environment
SANDBOX_MODE=mock bun run dev

// In firecracker.ts
if (config.isMock()) {
  // Returns fake sandbox with mock URLs
  sandbox.urls = {
    vscode: `https://sandbox-${sandboxId}.${config.caddy.domainSuffix}`,
    opencode: `https://opencode-${sandboxId}.${config.caddy.domainSuffix}`,
    ssh: `ssh root@${network.ipAddress}`,
  };
  sandbox.status = "running";
  sandbox.pid = Math.floor(Math.random() * 100000);
  return sandbox;
}
```

### Server Setup (First Time)

```bash
# On the server as root:

# 1. Install the CLI (after deployment)
# CLI is deployed to /usr/local/bin/atelier

# 2. Run full install
atelier init
# This runs: config → base → firecracker → network → ssh-proxy → storage
# Then updates the server bundle and optionally builds the base image

# 3. Start the manager
atelier manager start

# 4. Test a VM
atelier debug-vm start
atelier debug-vm ssh
atelier debug-vm stop
```

---

## Deployment Strategy

### Initial Server Setup

```bash
# On fresh Hetzner server (as root)

# 1. Run install script
curl -fsSL https://raw.githubusercontent.com/frak-id/oc-sandbox/main/infra/scripts/install.sh | bash

# This will:
#   - Configure system dependencies and Firecracker
#   - Setup network bridge and SSH proxy
#   - Configure storage (optional)
#   - Install the server bundle and services
#   - Optionally build the base image

# 2. Configure DNS
# Add wildcard A record: *.sandbox.frak.dev → server IP

# 3. Verify services
atelier manager status
```

### LVM Thin Pool Setup

```bash
# Manual reference (current flow uses `atelier storage`)

#!/bin/bash
set -euo pipefail

# Assuming /dev/nvme0n1p3 is available for sandbox storage
DEVICE="/dev/nvme0n1p3"
VG_NAME="sandbox-vg"
POOL_NAME="thin-pool"

# Create physical volume
pvcreate $DEVICE

# Create volume group
vgcreate $VG_NAME $DEVICE

# Create thin pool (use 90% of VG)
lvcreate -l 90%FREE -T ${VG_NAME}/${POOL_NAME}

# Create base volume
lvcreate -V 4G -T ${VG_NAME}/${POOL_NAME} -n base-rootfs

# Format and copy rootfs
mkfs.ext4 /dev/${VG_NAME}/base-rootfs
mount /dev/${VG_NAME}/base-rootfs /mnt
# ... copy rootfs contents ...
umount /mnt

echo "Storage setup complete"
echo "Thin pool: /dev/${VG_NAME}/${POOL_NAME}"
echo "Base volume: /dev/${VG_NAME}/base-rootfs"
```

### Systemd Services

**atelier-manager.service**:
```ini
[Unit]
Description=L'atelier Manager
After=network.target sandbox-network.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/atelier/apps/manager
ExecStart=/root/.bun/bin/bun run start
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=SANDBOX_MODE=production

[Install]
WantedBy=multi-user.target
```

---

## Implementation Roadmap

### Phase 1: Foundation (Week 1) ✅ COMPLETE

**Goals**: Server ready, basic spawn working

- [x] Provision Hetzner AX52
- [x] Run install script (CLI: `atelier init`)
- [x] Build minimal rootfs (Alpine + SSH)
- [x] Test manual Firecracker spawn (CLI: `atelier debug-vm start`)
- [x] Configure network bridge + NAT (CLI: `atelier network`)
- [ ] Setup LVM thin pool (CLI ready: `atelier storage`)
- [ ] Setup DNS wildcard

**Deliverables**:
- ✅ SSH into a Firecracker VM (`atelier debug-vm ssh`)
- ✅ VM has internet access

### Phase 2: Manager API (Week 2) ✅ COMPLETE

**Goals**: API can spawn/destroy sandboxes

- [x] Initialize Bun monorepo (workspaces: apps/*, packages/*, infra/*)
- [x] Implement services:
  - [x] `firecracker.ts` - VM lifecycle (spawn, destroy, status)
  - [x] `network.ts` - TAP management & IP allocation
  - [x] `caddy.ts` - Dynamic route registration
  - [x] `storage.ts` - LVM thin provisioning with auto-fallback
  - [x] `queue.ts` - Spawn job queue with concurrency control
- [x] Implement sandbox CRUD API (list, create, get, delete)
- [x] Add Swagger docs (`/swagger`)
- [x] Deploy with systemd (`scripts/deploy.ts`)
- [x] Mock mode for local development (`SANDBOX_MODE=mock`)

**Deliverables**:
- ✅ `POST /api/sandboxes` spawns a working VM
- ✅ Sandbox accessible via Caddy routes

### Phase 3: Enhanced Rootfs + Agent (Week 2-3) ✅ COMPLETE

**Goals**: Dev-ready sandbox environment

- [x] Add to rootfs:
  - [x] VSCode Server (code-server)
  - [x] OpenCode CLI
  - [x] Node.js, Bun, Git
  - [x] Sandbox agent binary
- [x] Implement sandbox-agent (`apps/agent`)
  - [x] Health endpoint with service checks
  - [x] Metrics endpoint (CPU, memory, disk)
  - [x] Exec endpoint for running commands
  - [x] Services endpoint for systemd status
  - [x] Apps endpoint for port registration
- [x] Configure sandbox-init (services start on boot)
- [x] Generate agent skill file (`SANDBOX.md`)

**Note**: Agent built with `--target=node` because Bun crashes with SIGILL inside Firecracker (AVX instruction issues).

**Deliverables**:
- ✅ VSCode + OpenCode accessible via Caddy routes
- ✅ Agent reports health/metrics on :9999

### Phase 4: Git, Projects & Prebuilds (Week 3) ✅ COMPLETE

**Goals**: Project-based workflow with fast spawns

- [x] Implement project CRUD (`/api/projects`)
  - [x] Create, read, update, delete projects
  - [x] Init commands (run during prebuild)
  - [x] Start commands (run on sandbox start)
  - [x] Secret management with encryption
  - [x] Exposed ports configuration
- [x] Implement prebuild system
  - [x] Trigger prebuild via API (`POST /api/projects/:id/prebuild`)
  - [x] LVM snapshot-based prebuilds
  - [x] Prebuild status tracking (none/building/ready/failed)
- [x] Integrate LVM thin provisioning for fast snapshots
- [x] Git clone during sandbox creation

**Deliverables**:
- ✅ Create project → trigger prebuild
- ✅ Spawn sandbox from prebuild (fast LVM clone)
- ✅ Secrets available in sandbox (encrypted storage)

### Phase 5: Dashboard (Week 3-4) ✅ COMPLETE

**Goals**: Functional admin UI

- [x] Setup TanStack Router + Query
  - [x] File-based routing with code splitting
  - [x] Query key factories with proper invalidation
- [x] Implement views:
  - [x] Dashboard overview (health status, system stats, storage)
  - [x] Sandbox list with filtering by status
  - [x] Sandbox detail (URLs, metrics, services, exec terminal)
  - [x] Project list with prebuild status
  - [x] Project detail with prebuild trigger
  - [x] Images list (base images)
  - [x] System page (stats, queue, cleanup)
- [x] Implement dialogs:
  - [x] Create sandbox (from base image or project)
  - [x] Create project (git URL, commands, secrets)
  - [x] Edit project
- [x] Sandbox lifecycle actions:
  - [x] Stop (pause VM)
  - [x] Start (resume VM)
  - [x] Delete
  - [x] Recreate (for error state with project)
- [x] Real-time updates via polling (5s intervals)

**Tech Stack**: React 19, TanStack Router/Query, Tailwind CSS, shadcn/ui, Vite

**Deployed**: https://sandbox-dash.nivelais.com/

**Deliverables**:
- ✅ Full sandbox lifecycle from UI (create, stop, start, delete)
- ✅ Project and prebuild management from UI

### Phase 6: Polish (Week 4) 🔄 IN PROGRESS

**Goals**: Production-ready

- [x] Error handling & recovery (custom SandboxError class)
- [x] Logging with pino (structured logging with child loggers)
- [x] Stop/Start lifecycle (Firecracker pause/resume)
- [ ] Cold/Warm state management (deferred - requires vCPU/memory hot-plug)
- [x] xterm.js interactive terminal (portable-pty in agent + xterm.js in dashboard)
- [ ] Documentation
- [ ] CI/CD pipeline

**Remaining Work**:
- **COLD state**: Reducing resources without full stop. Would require Firecracker hot-plug support or VM restart with different config. Deferred for now.
- **xterm.js terminal**: ✅ Implemented. Agent spawns PTY with nix crate, exposes WebSocket on port 7681. Manager proxies WebSocket to agent. Dashboard renders xterm.js inline.

**Deliverables**:
- ✅ Stable system for team use
- ⚠️ Documentation in progress (AGENTS.md, PROJECT.md)

---

## Future Considerations

### V1.1 - Enhanced Features
- [ ] **WireGuard mesh**: Direct IDE connections (bypass Caddy for SSH/IDE)
- [ ] **Workspace snapshots**: Save/restore sandbox state
- [ ] **Resource quotas**: Per-project limits
- [ ] **Metrics dashboard**: Grafana integration

### V2 - Multi-User / Product
- [ ] **Authentication**: OAuth with GitHub/GitLab
- [ ] **Multi-tenancy**: User isolation
- [ ] **Billing**: Usage tracking per user
- [ ] **Slack bot**: `/sandbox spawn project-name`

### V3 - Advanced AI Features
- [ ] **Multi-model execution**: Same prompt → multiple sandboxes with different LLMs
- [ ] **LLM proxy**: Centralized API key management
- [ ] **Prompt routing**: Route to best model based on task
- [ ] **Usage analytics**: Cost tracking per prompt/model

---

## Quick Reference

### Commands

```bash
# Development (local machine)
bun install                    # Install dependencies
bun run deploy                 # Build & deploy to server (requires .env)
bun run build:cli              # Build CLI for Linux

# Manager API (local development)
cd apps/manager
SANDBOX_MODE=mock bun run dev  # Start with mock Firecracker
# → http://localhost:4000
# → http://localhost:4000/swagger (API docs)

# CLI (on server, as root)
atelier                   # Interactive mode
atelier init              # Full install
atelier base              # Base packages only
atelier firecracker       # Download Firecracker + kernel + rootfs
atelier network           # Configure br0 bridge
atelier storage           # Setup LVM thin pool
atelier manager start     # Start manager service
atelier manager stop      # Stop manager service
atelier manager status    # Show service health
atelier manager logs      # Follow manager logs
atelier debug-vm start    # Start test VM
atelier debug-vm stop     # Stop test VM
atelier debug-vm status   # Show VM status
atelier debug-vm ssh      # SSH into test VM

# Systemd (on server)
systemctl status atelier-manager
journalctl -u atelier-manager -f
```

### Key Ports

| Service | Port | Access |
|---------|------|--------|
| Manager API | 4000 | sandbox-api.nivelais.com |
| Dashboard | - | sandbox-dash.nivelais.com (static files via Caddy) |
| Caddy Admin | 2019 | localhost only |
| Sandbox VSCode | 8080 | sandbox-{id}.nivelais.com |
| Sandbox OpenCode | 3000 | opencode-{id}.nivelais.com |
| Sandbox Agent | 9999 | Internal (VM) - manager calls via 172.16.0.x:9999 |

### Key Paths (Server)

| Path | Purpose |
|------|---------|
| `/opt/atelier` | Application root |
| `/opt/atelier/apps/manager/server.js` | Manager API bundle |
| `/opt/atelier/apps/dashboard/dist/` | Dashboard static files |
| `/opt/atelier/infra/images/sandbox-agent.mjs` | Agent bundle (copied to VMs) |
| `/usr/local/bin/atelier` | CLI binary |
| `/usr/local/bin/firecracker` | Firecracker binary |
| `/var/lib/sandbox/firecracker/kernels` | Kernel images |
| `/var/lib/sandbox/firecracker/rootfs` | Base rootfs images |
| `/var/lib/sandbox/overlays` | Per-sandbox writable layers |
| `/var/lib/sandbox/sockets` | Firecracker API sockets |
| `/var/lib/sandbox/data/sandbox.db` | SQLite database |
| `/var/log/sandbox` | Sandbox logs |
| `/dev/sandbox-vg/*` | LVM thin volumes (when storage configured) |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SANDBOX_MODE` | `production` | Set to `mock` for local development |
| `SANDBOX_HOST` | `0.0.0.0` | Manager bind address |
| `SANDBOX_PORT` | `4000` | Manager port |
| `CADDY_ADMIN_API` | `http://localhost:2019` | Caddy admin endpoint |
| `CADDY_DOMAIN_SUFFIX` | `sandbox.frak.dev` | Domain for sandbox URLs |
