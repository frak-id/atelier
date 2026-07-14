# Architecture

> K8s + Kata Containers orchestrator built as a Bun monorepo

## Technology Stack

### Application Layer

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | **Bun** | JS/TS runtime, bundler, package manager |
| Monorepo | **Bun Workspaces** | Workspace management |
| API Framework | **ElysiaJS** | Type-safe HTTP server |
| Frontend | **React** + **TanStack Router/Query** | Console SPA |
| Frontend Build | **Vite** | Dev server and bundling |
| Styling | **Tailwind CSS** + **shadcn/ui** | UI components |
| Validation | **TypeBox** | Runtime validation (Elysia native) |

### Infrastructure Layer

| Component | Technology | Purpose |
|-----------|------------|---------|
| Isolation | **Kata Containers** (Cloud Hypervisor) | VM-level sandbox isolation via K8s pods |
| Orchestration | **k3s** | Lightweight Kubernetes distribution |
| Storage | **TopoLVM** (CSI) | LVM thin provisioning, PVC snapshots |
| Reverse Proxy | **Traefik** (k3s built-in) + **K8s Ingress** | Dynamic routing, HTTPS |
| TLS | **cert-manager** (Cloudflare DNS-01) | Wildcard certificates |
| Base Image Builds | **BuildKit** (`buildctl`, in-cluster) | Base OCI image builds against a shared buildkitd daemon |
| Toolset Builds | **In-pod agent** | Content-addressed toolset artifacts (opencode, code-server, org toolboxes), built in a throwaway sandbox, pushed to Zot |
| Registry | **Zot** | Lightweight OCI registry for base images + toolsets |
| Database | **SQLite** (Drizzle ORM) | Sandbox, control-plane, and session state |

There is no build-from-UI feature — base images are built out-of-band via
`infra/k8s/v2/deploy.sh` / BuildKit, not triggered by the server at runtime.

---

## Monorepo Structure

```
atelier/
├── apps/
│   ├── server/           # Server (ElysiaJS) — runtime/control/sessions/api
│   ├── console/          # Web GUI (React + Vite)
│   ├── cli/               # @atelier/cli — host CLI (compiled Bun binary)
│   └── agent-v2/          # In-pod agent (Rust — lightweight, no AVX)
├── packages/
│   ├── shared/            # TypeBox schemas, config loaders (cross-app)
│   ├── spec/               # @atelier/spec — the SandboxSpec seam contract
│   └── compose/            # @atelier/compose — harness/preset/spec-merge SDK
├── charts/
│   └── atelier/            # Helm chart — SHARED CLUSTER INFRA ONLY
│                            # (Zot, CLIProxy, sshpiper, cert-manager, kata,
│                            #  snapshot class). Does not deploy the app.
├── infra/
│   ├── images/             # Base image Dockerfiles (dev-base, dev-cloud)
│   ├── nginx/               # Console nginx config (console.conf)
│   └── k8s/v2/              # Server + console app manifests (the deploy)
└── scripts/
    └── deploy-k8s.sh        # Build agent image + push + helm deploy the infra chart
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

Pause/resume reuses the live PVC when it still exists (no re-clone); when the
pod has been fully torn down it clones from the persisted pause snapshot, or
falls back to the original source spec. `error` records are resumable too.

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

### Toolsets (content-addressed tool delivery)

Tools like code-server, opencode, and org-defined toolboxes are **not**
baked into base images or mounted from a shared PVC. They're built once as
content-addressed artifacts (`toolsets/{name}@{digest}`), pushed to Zot, and
materialized by the in-pod agent into the overlay home before the primary
process starts (see [Constraints](constraints.md#toolsets-are-content-addressed-not-shared-pvc)).

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
│         │ Traefik (:443, TLS) → K8s Ingress                     │
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
  Internet → Traefik (:443) → K8s Ingress → Service → Pod:port
```

---

## K8s Ingress Routing

```
┌─────────────────────────────────────────────────────────────────┐
│                     K8s Ingress                                 │
│                                                                 │
│  Static Routes (infra/k8s/v2-managed Ingress):                  │
│  └── {domain.dashboard}                                         │
│      ├── /v1/*, /api/*, /sessions/*, /auth/*, /health, /swagger*│
│      │   → server container, same pod, :4000                    │
│      └── * → console container, same pod, :8080 (nginx)        │
│                                                                 │
│  Dynamic Routes (K8s Ingress, created by the server):           │
│  ├── sandbox-{id}.{DOMAIN}    → svc/sandbox-{id}:8080 (VSCode) │
│  ├── opencode-{id}.{DOMAIN}   → svc/sandbox-{id}:3000 (OC)     │
│  ├── dev-{name}-{id}.{DOMAIN} → svc/sandbox-{id}:3001 (Dev)    │
│  └── browser-{id}.{DOMAIN}    → svc/sandbox-{id}:6080 (Kasm)   │
│                                                                 │
│  Features:                                                      │
│  ├── Wildcard TLS via cert-manager (Cloudflare DNS-01)          │
│  └── Host-based routing via K8s Ingress resources               │
└─────────────────────────────────────────────────────────────────┘
```

Server and console run as two containers in **one pod** (same origin, so the
`sandbox_token` cookie and WS/SSE need no CORS) — see
`infra/k8s/v2/50-deployment.yaml`.

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
│  ├── workspace-pvc → /data (CoW clone from VolumeSnapshot;      │
│  │                    /data/upper + /data/work back the overlay)│
│  ├── ssh-pipe-key   → /etc/sandbox/ssh (sshpiper public key)    │
│                                                                 │
│  Filesystem (/home/dev is an OVERLAY, not the PVC mount itself: │
│  skel + toolset squashfs blobs as read-only lowers, /data/upper │
│  as the writable upper — see toolset-overlay-squashfs.md):      │
│  /                                                              │
│  ├── usr/local/bin/                                             │
│  │   └── sandbox-agent      # In-pod agent binary (atelier-agent)│
│  ├── home/dev/               # Overlay-assembled at boot         │
│  │   ├── workspace/         # Project code                      │
│  │   ├── .local/, .config/  # Materialized toolset content      │
│  │   └── SANDBOX.md         # Agent skill file                  │
│  ├── etc/sandbox/                                               │
│  │   ├── sandbox-boot.sh    # Pod entrypoint                    │
│  │   └── ssh/authorized_keys # sshpiper public key (mounted)    │
│  └── data/                  # PVC mount: upper/work/toolsets    │
│                                                                 │
│  Services (started by sandbox-boot.sh → sandbox-agent):         │
│  ├── sandbox-agent (TCP:9998, config + processes)               │
│  ├── attach bridge (TCP:9997, stdio/PTY relay)                  │
│  ├── terminal WS relay (TCP:7681, ad-hoc login shells)          │
│  ├── code-server, opencode serve, browser stack — per spec      │
│  └── sshd (:22, via sshpiper routing)                           │
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
│  Toolset artifacts (in Zot registry, content-addressed):        │
│  ┌──────────────────────────┐  ┌──────────────────────────┐     │
│  │ toolsets/opencode@sha256 │  │ toolsets/tb/org/…@sha256 │     │
│  └──────────────────────────┘  └──────────────────────────┘     │
│                                                                 │
│  Prebuild VolumeSnapshots (per-saved-spec):                     │
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

A lightweight Rust binary (`atelier-agent`) running inside each sandbox pod,
communicating with the server via TCP.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Sandbox Agent                                 │
│                                                                 │
│  Core Responsibilities:                                         │
│  ├── Config API (TCP:9998) — runtime pushes SandboxSpec-derived │
│  │   config, agent supervises processes accordingly             │
│  ├── Process supervision — readiness/primary/after/restart/lazy │
│  ├── Overlay materialize — assembles /home/dev from toolset     │
│  │   squashfs blobs + /data/upper before sshd starts            │
│  ├── Attach bridge (TCP:9997) — unified stdio/PTY relay with a  │
│  │   single-writer guard, used for ACP sessions and process     │
│  │   attach                                                     │
│  ├── Terminal WS relay (TCP:7681) — ad-hoc login shells         │
│  ├── File system operations, command execution (/exec)          │
│  └── Toolset build/capture (content-hash artifacts pushed to Zot)│
└─────────────────────────────────────────────────────────────────┘
```

**Why Rust?** Bun crashes inside Cloud Hypervisor VMs due to AVX
instruction issues (SIGILL). The agent is compiled as a static musl binary
(`FROM scratch` image) for maximum compatibility.

---

## API Overview

The server exposes its API on port 4000, split into three surfaces plus MCP:

| Group | Prefix | Description |
|-------|--------|--------------|
| Health | `/health`, `/health/live`, `/health/ready` | Liveness and readiness probes |
| Runtime (mechanism) | `/v1/sandboxes`, `/v1/prebuilds`, `/v1/toolsets` | Sandbox lifecycle: prebuild/boot/pause/resume/destroy, files/env/processes/ports/exec/attach |
| Control (policy) | `/api/organizations`, `/api/saved-specs`, `/api/secrets`, `/api/toolboxes`, `/api/api-keys`, `/api/ssh-keys`, `/api/org-policy`, `/api/config`, `/api/capabilities` | Identity, orgs, saved specs, secrets, toolboxes |
| Sessions | `/sessions/*` | Agent app-tier: ACP client sessions, terminal |
| Auth | `/auth/*` | GitHub OAuth |
| MCP | `/mcp` | Same three surfaces exposed as MCP tools for AI agents |

Full API documentation is available at `/swagger` when the server is running.
