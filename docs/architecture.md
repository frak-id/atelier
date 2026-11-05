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
| Base Image Builds | **BuildKit** (`buildctl`, in-cluster) | Seed image builds against a shared buildkitd (`imageBuilder.endpoint`, required for `kind=buildkit`); local mode builds seeds with the host Docker daemon |
| Toolset Builds | **In-pod agent** | Content-addressed toolset artifacts (opencode, code-server, org toolboxes), built in a throwaway sandbox, pushed to Zot |
| Registry | **Zot** | Lightweight OCI registry for base images + toolsets |
| Database | **SQLite** (Drizzle ORM) | Sandbox, control-plane, and session state |

Base images are built in-cluster by the server's image builder from the
embedded seeds (`apps/server/src/runtime/registry/seeds/`), triggered from the
console (server admins only); `infra/k8s/deploy.sh` can also bootstrap them
out-of-band. Custom Dockerfile and zip builds do not exist: a base image is a
seed build or a registered external ref.

---

## Monorepo Structure

```
atelier/
├── apps/
│   ├── server/           # Server (ElysiaJS): runtime, control, sessions,
│   │                     #   harnesses, config, api (+ api/app, api/mcp)
│   ├── console/          # Web GUI (React + Vite)
│   └── agent/            # In-pod agent (Rust, no AVX dependency)
├── packages/
│   └── spec/             # @atelier/spec: SandboxSpec and shared wire types
├── infra/
│   ├── k8s/              # Server + console manifests (the deploy)
│   └── nginx/            # Console nginx config (console.conf)
├── docker-compose.local.yml  # Local mode launcher
└── scripts/
    └── bump-version.ts   # Release version bump
```

The config schema and loader live in `apps/server/src/config/`. Harness
definitions (opencode, pi) and the spec merge live in
`apps/server/src/harnesses/`.

---

## Core Concepts

### Sandbox Lifecycle

| Status | Meaning |
|--------|---------|
| `creating` | Volume and pod booting, agent config and files being applied |
| `running` | Operational |
| `paused` | Pod deleted, volume kept (the Service and Ingresses stay so a request can wake it) |
| `stopped` | Pod terminated, volume preserved |
| `error` | Failed to start or crashed; resumable |

Create, fork, pause, resume, snapshot and destroy run as jobs in the job feed
(`GET /v1/jobs`, SSE at `/v1/jobs/events`), whether they come from HTTP or
MCP. The orchestration lives in `api/app/sandbox-ops.ts`; the mechanism stays
in `runtime/`.

**Pause and resume.** `pause()` syncs, snapshots, records the pause snapshot
and deletes the pod. `resume()` reuses the live volume when it still exists,
else clones from the pause snapshot, else falls back to the sandbox's stored
boot image. After a successful resume the previous pause snapshot is deleted;
a failed resume keeps it. `error` records are resumable too.

**Boot image.** `sandboxes.image` records the image a sandbox booted from, so
snapshots, resume and forks do not re-resolve the source. `bootedFrom`
(`ref`, `kind`, `image`, repo heads, build time) on the sandbox state shows
which prebuild, snapshot or image it started from.

**Snapshots.** Each snapshot has a kind: `prebuild`, `pause`, `fork` or
`manual`. `snapshot.manualKeep` (default 5) keeps the newest manual snapshots
per sandbox and never deletes one another sandbox boots from. Destroying a
sandbox re-owns snapshots that other sandboxes still boot from before it
sweeps its own.

**Live changes.** Adding a port or process, or patching env, needs a running
sandbox and runs under the per-sandbox operation lock. `reconcileOnStartup()`
marks zombie `creating` and pod-less `running` records as `error` at boot.

### Auto-resume on access

A paused sandbox wakes when something uses it:

| Access | Path |
|--------|------|
| Tool URL with `auth: "forward"` | Traefik asks `GET /auth/forward`; a signed-in caller who can access the sandbox triggers a resume and gets 503 until it runs |
| Public preview URL | Traefik asks `GET /auth/wake` (middleware `atelier-wake`), which needs no login |
| SSH | The gateway resumes and waits up to 3 minutes |
| Operations | `exec`, files, process actions and `send_prompt` resume the sandbox (`SandboxOps.ensureRunning`, up to 120 s) |

Only `paused` wakes, not `error`. A failed wake-up has a 30 s retry cooldown,
and concurrent requests share one `sandbox-resume` job. See
[idle-autopause.md](idle-autopause.md#8-auto-resume).

### Idle auto-pause

A running sandbox nobody uses is paused after the operator's idle time
(`sandbox.idle.*` server config, default 120 min, `observe` mode first).
Activity is what a person or an agent does to it: SSH and console input,
mutating API and MCP calls, ACP turns driven through Atelier (all seen by the
server), plus network bytes above a per-minute threshold, file writes under
the home and optionally CPU (measured by the in-pod agent, `GET /activity`).
Open-but-idle connections do not count: bytes do, not sockets. A turn in
flight, a job on the sandbox or a user's bounded keep-awake hold the pause.
The reaper (`api/idle-reaper.ts`) runs every minute from `api/scheduler.ts`.
See [idle-autopause.md](idle-autopause.md).

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

The prebuild key includes each repo's remote HEAD. If a HEAD cannot be
resolved, the prebuild fails with `REPO_UNREACHABLE` instead of baking on a
partial key. Spawn-time bakes and scheduled rebuilds (every 30 minutes when
`prebuild.gitTracking` is on, one job per moved recipe) run through the job
feed. If a spawn-time bake fails for a reason other than a client error or a
cancel, the spawn falls back to the recipe's newest snapshot and reports a
warning. Pruning keeps `prebuild.pruneKeep` superseded snapshots per recipe and
never deletes the newest one.

A prebuild can clone any number of repos and declare its projects' dev
servers as a **runtime surface in the toolbox scheme**
(`packages/spec/src/runtime-surface.ts`): `processes` + `ports` (several
for a monorepo), each process `lazy` or not. It's runtime content, not
snapshot content: it never enters the content key, so editing it never
re-bakes. It's a setting of the prebuild's *recipe* (`prebuildRecipeKey`),
shared by every snapshot of it, and only an explicit save writes it
(`POST /v1/prebuilds`, `PATCH /v1/prebuilds/:ref/surface`): a spawn
re-resolving a recipe never does, even when it bakes. Every sandbox
that boots from the prebuild gets it, layered by name at the
spawn seam (`api/spawn-surface.ts`, `SandboxOps`): the prebuild's, then
its toolboxes' (a toolbox beats a same-name prebuild entry, with a
warning), then the spec's own. A `lazy` process starts on first access
(the console's service gate).

### Toolsets (content-addressed tool delivery)

Tools like code-server, opencode, and org-defined toolboxes are **not**
baked into base images or mounted from a shared PVC. They're built once as
content-addressed artifacts (`toolsets/{name}@{digest}`), pushed to Zot, and
materialized by the in-pod agent into the overlay home before the primary
process starts (see [Constraints](constraints.md#toolsets-are-content-addressed-not-shared-pvc)).
Org toolboxes build to `toolsets/tb/<toolboxId>`; see
[toolbox-versions.md](toolbox-versions.md).

### Orgs, roles and secrets

- **Roles.** An org member is an `owner` or a `member`. Any member can create
  and edit the org's toolboxes; owners manage members, rename or delete the
  org and write secrets.
- **Default org.** `auth.defaultOrg` (env `ATELIER_DEFAULT_ORG`) names the team
  org. Every user who passes the GitHub gate joins it as `member` on first
  login, and it is the default spawn org. Its owners are the server admins.
  If the org does not exist yet, the first user to log in creates it and owns
  it. Without `defaultOrg`, everyone is an admin and a production boot warns.
- **Secrets.** Specs store `{"$secret": "NAME"}` references. Secrets resolve in
  the sandbox's org, and git credentials are rebuilt from the owner's current
  GitHub token, at every boot (create, resume, fork). A rotated secret applies
  on the next boot, and a secret deleted after creation makes a resume fail.
  Secret values and the GitHub token are AES-256-GCM encrypted at rest with
  `SANDBOX_SECRETS_KEY`, which production requires at startup.
- **Ownership transfer.** Secrets and toolboxes move between orgs by org id
  (`/api/transfers`).

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
│ │10.42 │ │10.42 │ │10.42 │ │10.42 │  (kata-atelier-clh-rs)    │
│ └──────┘ └──────┘ └──────┘ └──────┘                            │
└─────────────────────────────────────────────────────────────────┘

External traffic:
  Internet → Traefik (:443) → K8s Ingress → Service → Pod:port
```

**Isolation between sandboxes.** `infra/k8s/85-network-policy.yaml` makes the
sandbox namespace default-deny for ingress, then allows the Atelier server pod
and the ingress controller (Traefik in `kube-system`). A sandbox cannot reach
another sandbox's agent, sshd or tool ports. Egress is unrestricted. The
agent also requires a per-sandbox bearer token (see below), so the network
policy is the first line and the token the second.

---

## K8s Ingress Routing

```
┌─────────────────────────────────────────────────────────────────┐
│                     K8s Ingress                                 │
│                                                                 │
│  Static Routes (infra/k8s-managed Ingress):                  │
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
`infra/k8s/50-deployment.yaml`.

---

## Kata Sandbox Pod Anatomy

```
┌─────────────────────────────────────────────────────────────────┐
│                    Kata Sandbox Pod                              │
│                    (runtimeClassName: kata-atelier-clh-rs)       │
│                                                                 │
│  Resources (configurable per sandbox):                          │
│  ├── CPU: 500m-2000m (requests/limits)                          │
│  ├── RAM: 1Gi-4Gi (requests/limits)                             │
│  └── Boot time: ~1-2s (Cloud Hypervisor)                        │
│                                                                 │
│  Volumes:                                                       │
│  ├── workspace-pvc → /data (CoW clone from VolumeSnapshot;      │
│  │                    /data/upper + /data/work back the overlay)│
│  ├── ssh-pipe-key   → /etc/sandbox/ssh (gateway public key)     │
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
│  │   └── ssh/authorized_keys # gateway public key (mounted)     │
│  └── data/                  # PVC mount: upper/work/toolsets    │
│                                                                 │
│  Services (started by sandbox-boot.sh → sandbox-agent):         │
│  ├── sandbox-agent (TCP:9998, config + processes, bearer token) │
│  ├── attach bridge (TCP:9997: process attach, ACP, terminals)   │
│  ├── code-server, opencode serve, browser stack — per spec      │
│  └── sshd (:22, reached through the server's SSH gateway)       │
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
│  │ toolsets/opencode@sha256 │  │ toolsets/tb/<id>@sha256  │     │
│  └──────────────────────────┘  └──────────────────────────┘     │
│                                                                 │
│  Prebuild VolumeSnapshots (per recipe):                         │
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
communicating with the server via TCP. Every HTTP route except `GET /health`,
and the WebSocket listener, require the sandbox's bearer token
(`AGENT_PASSWORD`, generated at boot and kept in the sandbox record). WebSocket
URLs carry it as `?token=` because the server's relays dial bare URLs, so
never log them. With no token configured the agent answers 503 everywhere
except `/health`. `/health` reports the agent version and the server warns
once per sandbox when it differs from its own.

`exec` runs the command in its own process group and kills the group on
timeout or output overflow. The server sends a 30 s timeout when the caller
passes none.

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
│  │   attach; also serves ad-hoc terminal sessions at            │
│  │   /terminal/{id} (no separate terminal port)                 │
│  ├── File system operations, command execution (/exec)          │
│  ├── Activity measurement (GET /activity) — network bytes per   │
│  │   minute (interface counters), file writes (fanotify), CPU   │
│  │   (cgroup) for idle auto-pause                               │
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
| Health | `/health` | Liveness and readiness probe |
| Runtime (mechanism) | `/v1/sandboxes`, `/v1/prebuilds`, `/v1/toolsets`, `/v1/images`, `/v1/jobs` | Sandbox lifecycle, files, processes, ports, exec, attach, snapshots, the job feed |
| Control (policy) | `/api/users`, `/api/organizations`, `/api/transfers`, `/api/secrets`, `/api/toolboxes`, `/api/api-keys`, `/api/ssh-keys`, `/api/config`, `/api/github` | Identity, orgs, ownership transfers, secrets, toolboxes, server config |
| Sessions | `/sessions/*` | ACP sessions, terminal, and agent tasks (`/sessions/tasks`) |
| Auth | `/auth/*` | GitHub OAuth, `/auth/me`, `/auth/forward`, `/auth/wake` |
| MCP | `/mcp`, `/mcp/admin` | Sandbox tools for agents, and admin tools for server admins |

Full API documentation is at `/swagger` when the server is running.

### Application layer

HTTP routes and MCP tools are thin callers of `api/app/`
(`SandboxOps`, `ToolboxOps`), so both surfaces share validation, org
resolution, job tracking and auto-resume. `api/container.ts` only wires.

### MCP

Two endpoints, one auth. The bearer token is an `atl_` API key or a session
JWT. Each endpoint keeps its own session map; a session id from `/mcp` is
unknown (404) on `/mcp/admin`.

- `/mcp` has 13 tools, in this order: `whoami`, `get_sandbox`,
  `create_sandbox`, `sandbox_lifecycle`, `destroy_sandbox`, `exec`,
  `read_files`, `write_files`, `manage_process`, `expose_port`, `send_prompt`,
  `get_task`, `manage_task`.
- `/mcp/admin` has 4 tools: `manage_prebuilds`, `manage_toolbox`,
  `manage_images`, `server_config`. It answers 403 unless the caller is a
  server admin.

`api/mcp/tools/surface.test.ts` pins both lists, their order, the behaviour
annotations and the output schemas.

Conventions (`api/mcp/format.ts`):

- **Structured results.** Object results are returned as compact JSON text and
  as `structuredContent`; lists are wrapped in objects (`{sandboxes}`,
  `{tasks}`, `{prebuilds}`).
- **No credentials or internals.** `get_sandbox` never returns `generated`
  (agent password, pod IP, host keys). `manage_prebuilds` omits env values and
  file contents of the recipe.
- **Merged operations.** `get_sandbox` reads one sandbox or lists them;
  `sandbox_lifecycle` covers pause, resume, snapshot, fork and keep awake;
  `send_prompt` starts a task or continues one; `get_task` reads or lists.
  Params that apply to one mode only are rejected in the other.
- **Async by default.** `create_sandbox` returns `{id, status: "creating",
  jobId}` at once, and `get_sandbox` with `waitSeconds` (up to 50) waits for a
  status. `name` on `create_sandbox` is an idempotency key. Lifecycle actions
  wait up to `waitSeconds` (default 30) and otherwise return `{jobId}`.
- **Bounded output.** `exec` returns head and tail of each stream with an
  omitted marker; `read_files` caps bytes per file (default 32 KiB);
  `manage_process` logs and `get_task` replies take `maxChars`.
- **Auto-resume.** `exec`, `read_files`, `write_files`, `manage_process` and
  `send_prompt` resume a paused sandbox.
- **Ports.** `expose_port` takes `auth: "forward"` (default) or `"none"`.
- **Annotations.** Every tool declares `readOnlyHint`, `destructiveHint`,
  `idempotentHint` and `openWorldHint`.
- **Errors.** Unexpected failures are logged with the tool name. An unknown
  session id answers 404.

### Agent tasks

A task is one server-driven ACP session (`AgentDispatch.openSession`) plus
bookkeeping, implemented by `AgentTaskService` (`sessions/task.service.ts`).
The MCP tools (`api/mcp/tools/tasks.ts`) and the console routes
(`/sessions/tasks`) are thin callers.

- `send_prompt` returns at once; each prompt runs as a background turn.
  `get_task` (optionally long-polling, `waitSeconds` capped at 50 s) reports
  `running`, `idle`, `failed`, `cancelled` or `closed`, plus the reply.
  `turn.reply` is the agent's concluding message and appears once the turn has
  ended; while it runs you get `turn.progress` and recent `toolCalls`.
- **No permission step.** Every `session/request_permission` is answered at
  once with an allow (`allow_always`, else `allow_once`, else any non-reject
  option); the agent never waits for a person, and opencode is configured with
  `permission: "allow"`. The VM and the network policy are the boundary.
- **Persistence.** Tasks live in the `agent_tasks` table. A turn left running
  by a previous process is marked `failed` ("The server restarted during this
  turn"). A task idle for an hour is parked: its ACP connection is released and
  the next prompt reopens the session with `session/load` (a paused sandbox is
  resumed first). Tasks are forgotten after a week, and at most 20 are active
  per user.
- **Git result.** At the end of each non-failed turn the server runs one
  command in the task's cwd (5 s budget) and stores `{branch, headSha,
  commitsAhead, diffStat, capturedAt}`. A failure leaves the result empty and
  never fails the turn. There is no PR URL yet.
- **Routes.** `GET /sessions/tasks` and `GET /sessions/tasks/:taskId` list
  tasks in sandboxes the caller can access. `POST /sessions/tasks` starts one
  (`source: "console"`), `POST /:taskId/prompt` adds a turn, `POST
  /:taskId/cancel` cancels, `DELETE /:taskId` closes. Actions work only on
  tasks you dispatched.
- **Replay.** The ACP stream is attached with `replay=0`, so a new connection
  does not re-deliver an old turn's output.
- When a sandbox's `acp` process restarts, the connection notices a changed
  run (`pid`, `startedAt`) before a follow-up and every 10 s during a turn, so
  a turn fails instead of hanging.
- A reply holds the agent's answer only: harness status text (pi-acp's startup
  banner) is filtered through the harness's `startupNotice` and `isNotice`.

### Console

Top navigation: Sandboxes, Spawn, Library (prebuilds, toolboxes and toolsets,
images), Settings (API keys, SSH keys, secrets, config, organizations, users).
The home page leads with the task inbox (needs review, running, failed, seen)
above the sandbox list. A jobs page (`/jobs`) shows the job feed with logs and
cancel. Actions that need a server admin are hidden from other users.
