# Kata Containers Migration Plan

_Last updated: 2026-03-02 — Prebuild approach pivoted from OCI workspace images to PVC snapshots (TopoLVM)_

## Overview

Replace the custom bare-metal Firecracker orchestrator with **k3s + Kata Containers (Cloud Hypervisor)**. Single backend — raw Firecracker support is dropped entirely. No custom operator — manager talks to K8s API directly. Deployment becomes `helm install`. Zero host-level tooling — all operations go through the K8s API. No shell-outs, no `sudo`, no FFI, no direct filesystem access.

### Context: Recent Codebase Changes

The main branch has undergone two rounds of simplification since this plan was first drafted:

**Round 1 — Snapshot removal & boot optimization (c429a6a):**
- Memory snapshots removed (`pause()`, `resume()`, `createSnapshot()` deleted)
- Boot flow restructured into 3 phases, `jq` eliminated from boot path
- Current boot time: 1.5–2 seconds without snapshots

**Round 2 — Hexagonal architecture refactor (d0738bc):**
- Orchestration split into 3 layers: **kernel/** (FC-specific), **ports/** (DI boundary), **workflows/** (pure use-cases)
- `sandbox-spawner.ts` gutted from 804 → 99 LOC (thin dispatcher to workflows)
- `sandbox-lifecycle.ts` reduced from 566 → 364 LOC (restarts delegate to workflows)
- Prebuild runners unified: 3 files / 671 LOC → 1 file / 641 LOC
- `SandboxProvisionService` (283 LOC) deleted — logic moved to `ports/guest-*.ts`
- `SandboxPorts` interface defines the DI boundary — clean hexagonal architecture

**Impact on migration:** The Round 2 refactor is a game-changer. All Firecracker-specific code is now isolated in `kernel/` (561 LOC). Workflows and ports are hypervisor-agnostic — they import only from `kernel/` and `ports/`, never from `infrastructure/`. To migrate, we rewrite the kernel layer for K8s, delete `infrastructure/firecracker/`, `network/`, `proxy/`, `storage/`, and the entire CLI. No feature flags, no dual-backend — clean replacement.

## Architecture: Before & After

### Current (after refactor)

```
Bare metal server (root required)
├── Manager (Bun/Elysia, port 4000)
│   ├── orchestrators/
│   │   ├── kernel/          (561 LOC) ← FC-SPECIFIC, swap target
│   │   │   ├── sandbox-boot.ts    bootNew/bootExisting/finalize
│   │   │   ├── boot-waiter.ts     FC process polling
│   │   │   └── cleanup-coordinator.ts  ordered teardown
│   │   ├── ports/           (404 LOC) ← MINOR CLEANUP
│   │   │   ├── sandbox-ports.ts   SandboxPorts DI interface
│   │   │   └── guest-*.ts         GuestOps (DNS, git, secrets, services)
│   │   ├── workflows/       (420 LOC) ← MINOR CLEANUP
│   │   │   ├── create-workspace/system.ts
│   │   │   └── restart-workspace/system.ts
│   │   └── sandbox-spawner.ts (99 LOC, thin dispatcher)
│   └── infrastructure/      (4,141 LOC) ← mostly eliminated by K8s
│       ├── firecracker/     (277 LOC)
│       ├── network/         (274 LOC)
│       ├── proxy/           (827 LOC)
│       ├── storage/         (642 LOC)
│       └── registry/        (451 LOC) — Verdaccio host process
├── Caddy (reverse proxy, TLS)
├── Verdaccio (host process, managed by manager)
├── Firecracker VMs (one per sandbox)
│   └── Rust agent (vsock:9998) → terminal, exec, services, git
└── CLI (atelier) → server provisioning, LVM setup, image management
```

### After

```
k3s cluster (single or multi-node)
├── Manager + Dashboard (Deployment + PVC for SQLite)
│   ├── orchestrators/
│   │   ├── kernel/           (~300 LOC) ← REWRITTEN for K8s
│   │   │   ├── sandbox-boot.ts    create/delete Pod + Service + Ingress
│   │   │   ├── boot-waiter.ts     pod readiness polling
│   │   │   └── cleanup-coordinator.ts  kubectl delete pod,svc,ingress
│   │   ├── ports/           (~330 LOC) ← CLEANUP (FC guest ops removed)
│   │   ├── workflows/       (~380 LOC) ← MINOR CLEANUP (deleted ops removed)
│   │   ├── prebuild-runner.ts (~250 LOC) ← REWRITTEN (PVC snapshot orchestrator)
│   │   ├── sandbox-lifecycle.ts (~150 LOC) ← REWRITTEN (pod status monitoring)
│   │   └── sandbox-spawner.ts (99 LOC) ← UNCHANGED
│   └── infrastructure/
│       └── agent/            (~700 LOC, TCP transport)
├── Ingress controller (Traefik bundled with k3s, or nginx)
├── TopoLVM (CSI driver, LVM thin provisioning + VolumeSnapshots)
├── Zot registry (Deployment + PVC, base images only)
├── Verdaccio (Deployment + PVC, npm package cache)
├── Kaniko (Job pods, base image builds only — not workspace prebuilds)
├── Sandbox pods (runtimeClassName: kata-clh)
│   ├── Base image (dev-base or dev-cloud, from Zot)
│   ├── Workspace PVC (cloned from VolumeSnapshot via TopoLVM, per-workspace)
│   └── Slim agent (~1,500 LOC) → terminal, services, dev, git
└── VolumeSnapshots (per-workspace prebuilds, CoW via TopoLVM thin pool)
```

## What Changes Per Layer

### Kernel layer — REWRITE (561 LOC → ~300 LOC)

The kernel layer is the **only orchestrator code that touches Firecracker**. We rewrite it for K8s — same function signatures, different implementation. No abstraction layer, no interface — just replace the files.

| Current kernel file | What it does now | What it does after |
|---|---|---|
| `sandbox-boot.ts` (399) | allocate network → create LVM volume → launch FC → configure VM → boot → wait for agent → register Caddy/SSH routes | create PVC from VolumeSnapshot → create Pod + Service + Ingress → wait for pod Ready |
| `boot-waiter.ts` (79) | Poll `kill -0 $PID` + FC `isRunning()` every 50ms | Watch pod status via K8s API, read pod events on failure |
| `cleanup-coordinator.ts` (72) | Kill PID → rm sockets → delete LVM → delete TAP → release IP → remove Caddy → remove SSH | `kubectl delete pod,svc,ingress -l atelier.dev/sandbox=$id` |

Workflows call `bootNewSandbox()`, `bootExistingSandbox()`, `cleanupSandboxResources()` — same names, K8s implementation. Zero workflow changes.

### Sandbox lifecycle — REWRITE (364 LOC → ~150 LOC)

`sandbox-lifecycle.ts` monitors sandbox health and handles restarts. Currently FC-specific:
- `kill -0 $pid` for process liveness → **replaced by** K8s pod status API
- `test -S $path` for socket existence → **replaced by** pod readiness checks
- vsock repair via `FirecrackerClient.setVsock()` → **deleted** (no vsock in K8s, pods have normal TCP IPs)

Same lifecycle state machine, same restart logic, different health detection mechanism.

### Ports layer — CLEANUP (404 → ~330 LOC)

`SandboxPorts` interface stays. `GuestOps` functions need significant cleanup — most post-boot operations exist only because of Firecracker caveats that K8s + Kata + Cloud Hypervisor handles natively.

**Deleted from `guest-base.ts` (~74 LOC removed):**

| Operation | Why it exists | Why K8s handles it |
|---|---|---|
| `buildDnsCommand()` | FC VMs boot with empty `/etc/resolv.conf` | CoreDNS auto-populates pod DNS via kubelet |
| `buildClockSyncCommand()` | FC VMs need manual `chronyd` startup | Cloud Hypervisor provides `kvmclock` — **validated: no drift in Phase 1** |
| `buildHostnameCommand()` | FC VMs have no hostname set | K8s pod spec `hostname` field |
| `buildSwapCommand()` | Manually creates swapfile inside FC VM | K8s memory requests/limits; swap discouraged (`--fail-swap-on`) |
| `buildMountSharedBinariesCommand()` | ext4 image mounted as virtio block device | Binaries baked into base OCI image |
| `resizeStorage()` + `mknod` | LVM thin volumes need `resize2fs` after grow | PVC resize handled by TopoLVM CSI + `kubectl patch pvc` (no guest-side commands) |

**Stays unchanged:**
- `buildRuntimeEnvFiles()` — dynamic per-sandbox env (sandbox ID). Could move to K8s Downward API, but `writeFiles()` is simpler and already wired.
- `buildOhMyOpenCodeCacheFiles()` — seeds OpenCode provider cache, dynamic per-sandbox
- `buildSandboxMdFile()` — generated markdown, dynamic per-sandbox
- `startServices()` — agent manages process lifecycle inside the pod
- `guest-repo.ts` — git cloning and credential injection (unchanged)
- `guest-secrets.ts` — secret file collection and injection (unchanged)

### Workflows layer — MINOR CLEANUP (420 → ~380 LOC)

Workflows compose kernel + ports with zero infrastructure imports. They need minor cleanup to remove calls to deleted guest-ops functions (~10 LOC per workflow file):
- Remove `buildDnsCommand()`, `buildClockSyncCommand()`, `buildHostnameCommand()` from boot sequences
- Remove `buildSwapCommand()` and `resizeStorage()` from provisioning steps
- Remove `agent.setConfig()` calls (replaced by ConfigMap mounted at pod creation)

Remaining workflow logic (auth/config sync, secret injection, git clone, service start) is unchanged.

### Infrastructure — DELETE (except agent client)

| Deleted | LOC | Replaced by |
|---|---|---|
| `firecracker/` — FC client, launcher, paths | 277 | kernel/ K8s implementation |
| `network/` — TAP, bridge, IP allocation | 274 | K8s CNI (automatic) |
| `proxy/` — Caddy admin API, SSH proxy | 827 | K8s Ingress + Services |
| `storage/` — LVM, shared storage, ext4 image builder | 642 | TopoLVM CSI (PVC snapshots for workspace prebuilds) + Zot (base images only) |
| `registry/` — Verdaccio host process management | 451 | Verdaccio K8s Deployment (manager keeps HTTP client for settings/stats) |
| **Total deleted** | **2,471** | |

Kept: `agent/` (~700 LOC) with transport changed from vsock to TCP. `events/`, `cron/`, `database/`, `secrets/` stay as-is.

### Shared utilities — CLEANUP

`shared/lib/shell.ts` (105 LOC) — **deleted entirely**. All functions are FC/host-specific:
- `ensureDirAsRoot()`, `writeFileAsRoot()`, `injectFile()` → no sudo in K8s pod
- `killProcess()`, `cleanupSandboxFiles()` → K8s Pod termination + garbage collection
- `fileExists()`, `dirExists()` → inlined where still needed (app dir checks only)

### Health & system stats — REWRITE

`health.routes.ts` (74 LOC) — all 5 health checks are FC-specific (`FirecrackerClient.isHealthy()`, LVM available, Caddy healthy, bridge exists, sandbox dir exists). Rewritten to check: K8s API connectivity, Zot reachable, Kata RuntimeClass exists.

`system.routes.ts` + `mcp/tools/system.ts` — system stats (`top`, `free`, `df` shell commands) replaced by K8s metrics-server API. Orphan cleanup routes (find stale sockets/logs/overlays) deleted — K8s garbage collection handles this.

### Manager persistence

Manager Deployment gets a **PVC** for its SQLite database (`manager.db`). Without it, all workspace/sandbox state is lost on pod restart. Small volume (~100MB), local-path storage.

### CLI — DELETE entirely (3,141 LOC)

Replaced by `helm install`. Existing bare-metal users get a migration guide.

## What Stays (Slimmed Agent)

The Rust agent stays inside each sandbox but shrinks from ~3,040 to ~1,500 LOC:

| Feature | Keep? | Why |
|---|---|---|
| **Terminal/PTY (WebSocket)** | YES | Dashboard needs WebSocket terminals with session persistence, output buffering, reconnection. `kubectl exec` can't do this. |
| **Exec (used by GuestOps)** | YES | GuestOps calls `agent.exec()` / `agent.batchExec()` for git clone and custom init commands. FC-specific ops (DNS, clock, hostname, swap, resize) deleted — K8s handles them natively. |
| **File writing (used by GuestOps)** | YES | GuestOps calls `agent.writeFiles()` to push secrets, env files, git credentials, SANDBOX.md. Dynamic per-sandbox files, not static config. |
| **Services management** | YES | K8s manages containers, not processes inside containers. Sandboxes run multiple services (LSP, dev server, etc.). |
| **Dev commands** | YES | Same — per-process management inside sandbox. |
| **Git operations** | YES | Application logic, not infra. |
| **Process manager** | YES | Shared infra for services/dev. |
| **Health endpoint** | DELETE | K8s liveness/readiness probes replace the dedicated health route. |
| **Config push/get** | DELETE | `agent.setConfig()` replaced by ConfigMap mounted via virtio-fs. |
| **vsock transport** | DELETE | Pod has normal IP. Agent listens on TCP instead. |

**Key distinction:** GuestOps uses `agent.exec()`, `agent.writeFiles()`, and `agent.batchExec()` — these stay. What gets deleted are: (1) agent-side routes that K8s replaces (health, config), and (2) FC-specific guest ops that K8s handles natively (DNS, clock, hostname, swap, resize). The remaining GuestOps layer (~330 LOC) builds commands and files, pushes them through `ports.agent`, and doesn't care whether the transport is vsock or TCP.

## Internal Service Layer & Auto-Sync

The manager runs three continuous synchronization systems that push state to all running sandboxes. This architecture is **transport-agnostic** — the sync logic doesn't change for K8s. Only service discovery URLs need updating.

### Sync Systems

| System | File | Mechanism | Interval |
|---|---|---|---|
| **Auth sync** | `auth-sync.service.ts` (431 LOC) | Bidirectional: poll auth from all sandboxes → aggregate → push back to stale | Every 5s |
| **Config + registry sync** | `internal.service.ts` (284 LOC) | Push: merge global + workspace configs → push to all; inject npm registry URLs | On boot + on-demand via API |
| **Service + git polling** | `sandbox-poller.ts` (168 LOC) | Poll: hash service/git status → emit SSE events on change | Every 10s |

**Auth sync detail:** Reads auth files (`~/.local/share/opencode/auth.json`, `~/.config/opencode/antigravity-accounts.json`) from every running sandbox via `batchExec(stat + cat)`. For OAuth tokens, picks the entry with the newest expiry across all sandboxes. For opaque providers, last-edit-wins by mtime. Stores aggregated "best auth" in SQLite, pushes to every stale sandbox via `writeFiles()`. This is how "authenticate once in any sandbox, all others get it within 5 seconds" works.

**Config sync detail:** `ConfigFileService` stores global and workspace-scoped config files in SQLite. `InternalService.syncConfigsToSandboxes()` merges them (workspace overrides global, JSON deep-merged), then pushes to all running sandboxes grouped by workspace. Also handles npm registry URL injection (`/etc/npmrc`, `~/.bunfig.toml`, `~/.yarnrc.yml`).

**Event flow:** Config/workspace changes → `eventBus.emit()` → SSE to dashboard clients. Service mutations → `internalBus` → optimistic 2s re-poll → hash comparison → SSE event if changed.

### K8s Migration Impact

**Sync logic: zero changes.** Auth aggregation, config merging, polling, event bus, SSE — all pure business logic, transport-agnostic. Works identically over TCP.

**Service discovery URLs: ~20 LOC change.** All sandbox-to-host communication currently routes through `config.network.bridgeIp` (172.16.0.1). In K8s, this becomes K8s Service DNS:

| Current (bridgeIp) | K8s equivalent | Affected code |
|---|---|---|
| `http://172.16.0.1:7777` (Verdaccio) | `http://verdaccio.atelier-system.svc:4873` | `RegistryService.getRegistryUrl()`, `pushRegistryConfig()` |
| `http://172.16.0.1:4000` (Manager) | `http://manager.atelier-system.svc:4000` | `SandboxConfig.managerUrl` |
| Manual DNS in `/etc/resolv.conf` | CoreDNS handles automatically | `buildDnsCommand()` — deleted |

The `config.network.bridgeIp` config key is replaced by K8s service DNS names. Configuration change, not architectural.

## PVC Snapshot Prebuild System

Replaces the current LVM snapshot-based prebuild with **CSI VolumeSnapshots** via TopoLVM. Same conceptual flow as current — temp environment → run init → snapshot → clone for new sandboxes — but through K8s API instead of direct LVM commands. Zero host-level tooling.

### Two-Layer Architecture

```
Layer 1 — Base OCI image (shared, rarely rebuilt, stored in Zot)
  ├── dev-base:latest    Node 22, Bun, code-server, OpenCode, common tooling
  └── dev-cloud:latest   dev-base + AWS CLI, gcloud, kubectl

Layer 2 — Workspace PVC snapshot (per-workspace, re-snapshotted on trigger)
  └── prebuild-{workspace-id}
      Boot temp pod from dev-base + temp PVC
      → clone repos at pinned commits
      → run init commands (npm install, build, etc.)
      → VolumeSnapshot the PVC → delete temp pod + PVC
```

**Key advantage over OCI workspace images:** PVCs can be **resized** (`kubectl patch pvc`), support **CoW** via LVM thin provisioning (only changed blocks stored), and allow **incremental updates** (`git pull && npm install` on existing snapshot, then re-snapshot). No fixed rootfs size — storage grows with the workspace.

### Prebuild Flow: Current vs After

| Step | Current (direct LVM) | After (CSI VolumeSnapshot) |
|---|---|---|
| **1. Start** | Spawn temp Firecracker VM | Create temp PVC (e.g., 20Gi via TopoLVM) |
| **2. Boot** | Wait for FC process, configure VM | Create temp Pod (base image + PVC at `/home/dev`) → wait for agent |
| **3. Build** | Run init commands via agent exec | Same — run init commands via agent exec (clone repos, `npm install`) |
| **4. Store** | `lvcreate --snapshot` (direct LVM) | Create CSI `VolumeSnapshot` from temp PVC (TopoLVM thin snapshot, <100ms) |
| **5. Capture** | Record commit hashes from inside VM | Same — record commit hashes from agent exec output |
| **6. Cleanup** | Destroy temp VM + delete temp volume | Delete temp Pod + temp PVC (snapshot persists independently) |
| **On spawn** | `lvcreate --snapshot` clone → boot FC (1.5-2.5s) | Create PVC from VolumeSnapshot (CoW clone, <100ms) → boot pod with it |

Key differences from current system:
- **Zero host access** — no `lvcreate`, no `sudo`, no shell-outs. Manager only talks K8s API.
- **Same flow** — structurally identical to current prebuild. Temp env → init → snapshot → clone. Minimal conceptual change.
- **Resizable** — PVCs can be expanded after creation. `kubectl patch pvc` → filesystem grows.
- **Incremental updates** — New commits? Boot from existing snapshot → `git pull && npm install` → re-snapshot. Only delta blocks stored.

### Prebuild Triggers

Same triggers as current system:

| Trigger | Detection | Action |
|---|---|---|
| **Commit hash change** | Cron polling via `git ls-remote` (every 30min, same as current `PrebuildChecker`) | Create temp Pod + PVC → run init → VolumeSnapshot |
| **Base image update** | Detect when `dev-base` or `dev-cloud` is rebuilt (image digest change in Zot) | Re-snapshot all workspace PVCs that depend on it |
| **Manual trigger** | `POST /:id/prebuild` API endpoint (same as current) | Create temp Pod + PVC → run init → VolumeSnapshot on demand |

The `PrebuildChecker` stays mostly unchanged — same `git ls-remote` polling, same staleness logic. On stale detection, triggers a PVC-based prebuild instead of a VM-based snapshot.

### VolumeSnapshot Resources (example)

```yaml
# VolumeSnapshotClass (created once by Helm chart)
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: topolvm-snapshot
driver: topolvm.io
deletionPolicy: Delete
---
# Created by prebuild-runner.ts after init commands complete
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: prebuild-{workspace-id}-{short-hash}
  namespace: atelier-sandboxes
  labels:
    atelier.dev/component: prebuild
    atelier.dev/workspace: "{workspace-id}"
spec:
  volumeSnapshotClassName: topolvm-snapshot
  source:
    persistentVolumeClaimName: prebuild-temp-{workspace-id}
---
# Created for each new sandbox (PVC from snapshot = CoW clone)
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: sandbox-{id}-data
  namespace: atelier-sandboxes
spec:
  storageClassName: topolvm-provisioner
  dataSource:
    name: prebuild-{workspace-id}-{short-hash}
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 20Gi  # resizable via kubectl patch
```

### Wiring — how the manager orchestrates a prebuild:

```
1. Trigger fires (commit change / base image / manual)
         │
2. Manager creates temp PVC (20Gi, storageClass: topolvm-provisioner)
         │
3. Manager creates temp Pod (base image from Zot + PVC at /home/dev)
         │
4. Wait for agent ready → run init via agent exec:
   ├── Clone repos (git clone, git checkout)
   ├── Run init commands (npm install, build, etc.)
   └── Capture commit hashes
         │
5. Delete temp Pod (PVC stays)
         │
6. Create VolumeSnapshot from temp PVC
         │
7. Wait for snapshot readyToUse=true
   ├── Update workspace config with snapshot ref + commit hashes
   ├── Mark prebuild status "ready"
   └── Delete temp PVC (snapshot persists independently)
         │
   On failure: read pod logs, mark "failed", cleanup temp resources
         │
8. New sandboxes: create PVC from snapshot (CoW clone) → mount in pod
```

All steps are pure K8s API calls. No host access, no LVM commands, no shell-outs.

### Prebuild Runner Rewrite

The current `PrebuildRunner` (641 LOC) gets rewritten (~250 LOC):

| Current responsibility | After |
|---|---|
| Spawn temp VM via `SandboxSpawner` | Create temp PVC + Pod (base image + PVC) |
| Run init commands via agent exec | Same — agent exec (structurally identical) |
| Capture commit hashes via agent exec | Same — agent exec (structurally identical) |
| Warmup OpenCode inside VM | Warmup at pod boot (or skipped) |
| Push auth/configs via agent | Auth as K8s Secret mounted in pod, configs via agent writeFiles |
| `StorageService.createPrebuild()` (direct LVM) | Create CSI VolumeSnapshot → wait for readyToUse |
| Cleanup: destroy temp VM | Delete temp Pod + PVC (snapshot persists) |

The `PrebuildChecker` (133 LOC) stays mostly unchanged — same `git ls-remote` polling, same staleness logic. Only the action on stale changes: create PVC-based prebuild instead of spawning a VM.

### Build & Registry Infrastructure

#### TopoLVM (CSI storage driver)

[TopoLVM](https://github.com/topolvm/topolvm) provides LVM thin provisioning as a CSI driver. Deployed as DaemonSet + controller via Helm.

```yaml
# StorageClass for sandbox PVCs (created by Helm chart)
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: topolvm-provisioner
provisioner: topolvm.io
parameters:
  topolvm.io/device-class: "thin"
allowVolumeExpansion: true  # enables PVC resize
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
```

**What TopoLVM manages:**

| Resource | Purpose |
|---|---|
| Sandbox PVCs | Per-sandbox data volume (repos, deps, artifacts). Resizable. |
| Prebuild temp PVCs | Temp volumes for prebuild init. Deleted after snapshot. |
| VolumeSnapshots | Prebuild snapshots. CoW clones for new sandbox PVCs. |
| Thin pool | LVM thin pool on each node. Auto-extends if configured. |

**Prerequisites:** LVM volume group (VG) must exist on each node. Same as current system — the VG already exists for Firecracker LVM volumes.

#### Zot Registry (base images only)

[Zot](https://zotregistry.dev/) stores **base OCI images only** (not workspace prebuilds). ~15MB binary, ~30MB idle RAM.

```yaml
# Same Zot deployment, scoped to base images
apiVersion: apps/v1
kind: Deployment
metadata:
  name: zot
  namespace: atelier-system
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: zot
          image: ghcr.io/project-zot/zot-linux-amd64:latest
          ports:
            - containerPort: 5000
          volumeMounts:
            - name: data
              mountPath: /var/lib/zot
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: zot-data
---
apiVersion: v1
kind: Service
metadata:
  name: zot
  namespace: atelier-system
spec:
  selector:
    app: zot
  ports:
    - port: 5000
      targetPort: 5000
```

**What lives in Zot:**

| Image | Tag | Rebuilt when |
|---|---|---|
| `dev-base` | `latest` + date tag | Base image updated (manual or CI) |
| `dev-cloud` | `latest` + date tag | Base image updated (manual or CI) |

Workspace prebuilds are VolumeSnapshots, not OCI images — they don't go through Zot.

k3s containerd must be configured to pull from Zot:

```yaml
# /etc/rancher/k3s/registries.yaml
mirrors:
  "zot.atelier-system.svc:5000":
    endpoint:
      - "http://zot.atelier-system.svc:5000"
```

#### Kaniko (base image builds only)

[Kaniko](https://github.com/GoogleContainerTools/kaniko) builds base OCI images (dev-base, dev-cloud) inside a K8s pod. Only used for **base image rebuilds** (tooling updates, new runtime versions), **not** for workspace prebuilds. Base image builds are infrequent and can alternatively be done externally via CI and pushed to Zot.

### Verdaccio (npm package cache)

Currently managed as a host process by the manager (dynamic import, process lifecycle, filesystem eviction). Becomes a standalone **K8s Deployment** in the Helm chart.

```yaml
# Deployed via Helm chart
apiVersion: apps/v1
kind: Deployment
metadata:
  name: verdaccio
  namespace: atelier-system
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: verdaccio
          image: verdaccio/verdaccio:6
          ports:
            - containerPort: 4873
          volumeMounts:
            - name: storage
              mountPath: /verdaccio/storage
            - name: config
              mountPath: /verdaccio/conf
      volumes:
        - name: storage
          persistentVolumeClaim:
            claimName: verdaccio-data
        - name: config
          configMap:
            name: verdaccio-config
---
apiVersion: v1
kind: Service
metadata:
  name: verdaccio
  namespace: atelier-system
spec:
  selector:
    app: verdaccio
  ports:
    - port: 4873
      targetPort: 4873
```

Manager keeps a thin HTTP client for registry stats/management (~50 LOC). All process lifecycle, `bun add verdaccio`, filesystem eviction — deleted. Verdaccio manages its own storage in the PVC. Package eviction becomes a K8s CronJob or Verdaccio's built-in config.

### Why Cloud Hypervisor over Firecracker

| Feature | Firecracker | Cloud Hypervisor |
|---|---|---|
| CPU hot-plug | NO | YES |
| Memory hot-plug | YES (virtio-mem) | YES (virtio-mem + ACPI) |
| virtio-fs (live file sharing) | NO | YES |
| Boot time | ~125ms | ~200ms |
| Kata default | No | YES (since 3.x) |

Cloud Hypervisor is Kata's default VMM. The ~75ms boot penalty is negligible — sandbox pods boot from base images with workspace data on a PVC (cloned from snapshot).

## New Code Required

| Component | LOC | Language |
|---|---|---|
| `kernel/sandbox-boot.ts` — pod lifecycle | ~200-250 | TypeScript |
| `kernel/boot-waiter.ts` — pod readiness | ~40 | TypeScript |
| `kernel/cleanup-coordinator.ts` — pod deletion | ~30 | TypeScript |
| `sandbox-lifecycle.ts` — pod status monitoring | ~150 | TypeScript |
| `prebuild-runner.ts` — PVC + temp Pod + VolumeSnapshot orchestrator | ~250 | TypeScript |
| `health.routes.ts` — K8s health checks | ~50 | TypeScript |
| `system.routes.ts` — K8s metrics stats | ~30 | TypeScript |
| Helm chart (manager, TopoLVM config, Zot, Verdaccio, RBAC, RuntimeClass, Ingress, VolumeSnapshotClass) | ~450 | YAML |
| Base image Dockerfile (dev-base rootfs, with code-server + OpenCode baked in) | ~80 | Dockerfile |
| Agent transport (vsock→TCP, ~50 LOC net change) | ~50 | TypeScript |
| **Total new** | **~1,330-1,380** |

## K8s Overhead on Single VPS

| Component | Idle RAM | Idle CPU |
|---|---|---|
| **k3s (stripped)** | ~1,200-1,400MB | 5% of 1 core |
| **TopoLVM** (lvmd DaemonSet + controller) | ~130MB | negligible |
| **Zot registry** | ~30MB | negligible |
| **Verdaccio** | ~80MB | negligible |
| **Kaniko** | 0 (Job pods, only runs for base image builds) | 0 |
| **Total overhead** | ~1,440-1,640MB | ~5% of 1 core |

On a 32GB VPS, total overhead = ~4.7% RAM. Roughly 1 sandbox worth of memory.

```bash
# Minimal k3s install (local-path-provisioner needed for PVCs)
curl -sfL https://get.k3s.io | sh -s - \
  --disable=traefik \
  --disable=servicelb \
  --disable=metrics-server
```

## Migration Phases

### Phase 1: Validate Stack ✅ COMPLETED (2026-03-01)

Validated on production VPS (Ubuntu 22.04, 62GB RAM, 5.15.0-171-generic) alongside live Firecracker setup.

**Results:**

| Test | Result |
|------|--------|
| k3s install (coexisting with FC) | ✅ FC health checks pass throughout |
| Kata + Cloud Hypervisor (helm chart) | ✅ v3.27.0, `kata-clh` runtime |
| Kata pod boot | ✅ ~1s (guest kernel 6.18.12 vs host 5.15.0-171) |
| Pod IP reachable from host | ✅ 10.42.0.0/16, no conflict with FC 172.16.0.0/24 |
| kubectl exec into Kata pod | ✅ |
| Zot registry (PVC + local-path) | ✅ cluster-internal at 10.43.x.x:5000 |
| Kaniko build + push to Zot | ✅ ~3s build for alpine+curl+bash |
| Kata pod from Zot image | ✅ full circuit working |

**Gotchas found (document for Helm chart):**

1. **cgroup v2 fix required**: `sandbox_cgroup_only=true` in `configuration-clh.toml` — without it, Kata shim constructs invalid cgroup paths with colons on cgroup v2 systems
2. **k3s Kata helm values**: must set `k8sDistribution=k3s`, `shims.disableAll=true`, `shims.clh.enabled=true`, `defaultShim.amd64=clh`
3. **registries.yaml needs ClusterIP**: containerd runs on host, can't resolve K8s DNS names — use Zot Service ClusterIP in the endpoint, not the DNS name
4. **Keep local-path-provisioner**: don't `--disable=local-storage` in k3s install — needed for Zot PVC

**Exit criteria**: ✅ All met — Kata pod boots from Zot image, exec works over TCP, Kaniko builds and pushes successfully

### Phase 2: Rewrite Core ✅ COMPLETED (2026-03-02)

Completed in 11 incremental commits on branch `task/task_cub8c7l17pqy`:

| # | Commit | Description |
|---|--------|-------------|
| 1 | `866128d` | feat: add custom fetch()-based K8s client infrastructure (~560 LOC) |
| 2 | `f502ba9` | refactor: replace vsock agent transport with TCP fetch |
| 3 | `794cd8b` | refactor: rewrite kernel layer for K8s pod orchestration |
| 4 | `3234e23` | refactor: rewrite sandbox lifecycle and destroyer for K8s |
| 5 | `1145e4a` | refactor: remove FC-specific guest ops from workflows |
| 6 | `9075045` | refactor: update service discovery URLs for K8s |
| 7 | `dc3aff8` | refactor: rewrite health routes for K8s checks |
| 8 | `8989d52` | refactor: rewrite prebuild system to use Kaniko + Zot |
| 9 | (folded into 8) | DI wiring — KubeClient added to container.ts |
| 10 | `039a5fb` | chore: delete FC, network, proxy, storage, and shared-storage infra |
| 11 | (this commit) | chore: final cleanup — stale references, AGENTS.md, migration plan |

**What was done:**

- ✅ Custom fetch()-based K8s client (not `@kubernetes/client-node` — Bun compat issues, see decision D1)
- ✅ **Kernel layer rewrite:** sandbox-boot, boot-waiter, cleanup-coordinator — all K8s pod lifecycle
- ✅ **Sandbox lifecycle rewrite:** pod status monitoring via K8s API replaces process checks
- ✅ **Prebuild rewrite:** Kaniko Job orchestrator + Zot registry (~527 LOC) replaces LVM snapshots
- ⚠️ **Prebuild pivot:** Kaniko-based OCI workspace images (commit 8) being replaced with PVC snapshot approach (TopoLVM + CSI VolumeSnapshots). Prebuild runner will be rewritten to orchestrate temp Pod + PVC → VolumeSnapshot instead of Kaniko Job. See updated "PVC Snapshot Prebuild System" section.
- ✅ **Agent transport:** vsock → TCP fetch (pod IP from K8s Service DNS)
- ✅ **Guest ops cleanup:** deleted DNS, clock, hostname, swap, mount, resize (K8s handles natively)
- ✅ **Workflow cleanup:** removed deleted guest-ops calls, updated comments
- ✅ **Service discovery URLs:** K8s Service DNS replaces bridgeIp references
- ✅ **Health routes:** check K8s API, Kata RuntimeClass, Zot registry instead of FC/LVM/Caddy
- ✅ **Proxy → Ingress:** Caddy proxy routes replaced with K8s Ingress resources via KubeClient
- ✅ **Cleanup:** deleted firecracker/, network/, proxy/, storage/ dirs (18 files, ~2,000 LOC)
- ✅ **Cleanup:** deleted shared-storage routes/schemas, trimmed shell.ts to 3 generic functions
- ✅ **Cleanup:** updated all AGENTS.md files, removed stale FC references from comments/types
- ✅ Internal service layer unchanged — auth sync, config sync, registry sync, poller all transport-agnostic

**Decisions documented:** D1-D8 in `docs/kata-migration-interrogation.md`
**Questions resolved:** Q1-Q3 (prebuild strategy, manager deployment, shell.ts scope)

**Net LOC change:** ~85 insertions, ~2,641 deletions in commit 10 alone. Total Phase 2: ~2,500 new LOC, ~4,600 deleted.

**Exit criteria:** ✅ Manager compiles clean (`tsc --build` + `biome check`), zero imports from deleted infrastructure, all sandbox lifecycle + prebuild + health routes rewritten for K8s.
**Remaining:** End-to-end testing on live K8s cluster (Phase 3 prerequisite).

### Phase 3: Helm + Ship (1-2 weeks)

Code deletion already completed in Phase 2. Remaining work:

- Write Helm chart: manager Deployment + PVC, RBAC, RuntimeClass, Ingress defaults, Zot Deployment + PVC + Service, Verdaccio Deployment + PVC + Service + ConfigMap, TopoLVM StorageClass + VolumeSnapshotClass, containerd registries.yaml config
- Delete remaining old code:
  - `infrastructure/registry/` (451 LOC) — host process management (keep HTTP client)
  - `apps/cli/` (3,141 LOC) — replaced by `helm install`
- End-to-end testing on live K8s cluster
- Write migration guide for existing bare-metal users
- **Exit criteria**: `helm install` on fresh k3s cluster, everything works

### Phase 4: Ship (1 week)

- Final testing on production server
- Update README, docs, quickstart
- Deploy to production
- Decommission old bare-metal setup

**Total: 5-8 weeks**

## Future Unlocks

- **Warm pool**: Pre-create 1 PVC per workspace from its prebuild snapshot. On spawn, pod claims the pre-cloned PVC instead of creating one on the fly. Combine with `InPlacePodVerticalScaling` (K8s 1.35+, Cloud Hypervisor) for hot-plug CPU + memory. Reduces spawn time from ~200-300ms to near-instant. Requires: pool controller (~150 LOC), replenishment logic. Nice-to-have once core migration is stable.
- **SSH proxy pod**: If devs need `ssh sandbox-id@host` with key rotation (current sshpiper feature), deploy sshpiper as a small K8s Deployment that proxies SSH to sandbox pods. For now, `kubectl exec` + dashboard WebSocket terminals cover the use case.
- **Multi-node**: Join a second k3s node. K8s scheduler places sandboxes automatically. Zot already handles image distribution — nodes pull from it.
- **Operator (if needed)**: Extract sandbox lifecycle into CRD + reconciler when manager-as-controller pattern breaks down (HA, complex warm pools, `kubectl get sandboxes` observability).
- **Language**: Operator would be Rust (kube-rs), shared crates with agent.

## Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Boot time regression with Kata | LOW | Current boot is 1.5-2s with full LVM + FC setup. Kata pod with PVC from snapshot: ~200-300ms — a significant improvement. |
| K8s overhead on small VPS | LOW | k3s stripped + Zot + Verdaccio = ~1.5GB. Acceptable on 16GB+. |
| Network policy limitations (Kata TC model) | LOW | Test with chosen CNI. Basic routing works fine. |
| Cloud Hypervisor less battle-tested than FC | LOW | It's Kata's default. Northflank uses it in production. |
| Prebuild init time for large workspaces | LOW | Structurally identical to current system (agent exec). Incremental updates possible: boot from existing snapshot, `git pull && npm install`, re-snapshot. |
| VolumeSnapshot data loss | LOW | TopoLVM snapshots live on LVM thin pool. Same durability as current LVM approach. Back up VG for critical setups. |
| TopoLVM maturity | LOW | Production-grade CSI driver, CNCF sandbox project. Used by CyberAgent, Yahoo Japan at scale. |
| Zot registry data loss | LOW | PVC on local-path storage. Base images only — rebuild from Dockerfiles if lost. |
| Manager DB loss on pod restart | LOW | PVC for SQLite. Small volume, local-path storage. Backup via k8s CronJob if needed. |
| Gitpod left K8s for similar use case | MEDIUM | Gitpod operates at massive multi-tenant scale. Single/few-tenant is different. |

## LOC Summary

Updated numbers from current main (`d0738bc`):

### What gets deleted

| Deleted code | LOC |
|---|---|
| kernel/ FC implementation | 561 |
| infrastructure/firecracker/ | 277 |
| infrastructure/network/ | 274 |
| infrastructure/proxy/ | 827 |
| infrastructure/storage/ | 642 |
| infrastructure/registry/ (host process mgmt) | 451 |
| shared/lib/shell.ts (FC host utilities) | 105 |
| sandbox-lifecycle.ts (FC-specific monitoring) | 364 |
| CLI (apps/cli/) | 3,141 |
| Agent endpoints (health, config, vsock) | ~1,540 |
| Infra scripts | ~230 |
| **Total deleted** | **~8,412** |

### What gets written

| New code | LOC |
|---|---|
| kernel/ K8s implementation | ~300 |
| sandbox-lifecycle.ts (pod monitoring) | ~150 |
| Prebuild runner (PVC snapshot orchestrator) | ~250 |
| Health routes + system stats (K8s API) | ~80 |
| Registry client (HTTP to Verdaccio) | ~50 |
| Helm chart (manager + TopoLVM config + Zot + Verdaccio + RBAC) | ~450 |
| Dockerfiles (base image template) | ~80 |
| Agent transport change | ~50 |
| **Total new** | **~1,410** |

### Net result

| | Before | After | Delta |
|---|---|---|---|
| Manager (infra + orchestrators) | ~7,555 | ~3,754 | -3,801 |
| CLI | 3,141 | 0 | -3,141 |
| Agent | 3,040 | ~1,500 | -1,540 |
| Infra scripts | 480 | ~250 | -230 |
| **Total** | **~14,216** | **~5,504** | **-8,712** |

### Key insight

The hexagonal refactor isolated all FC-specific code into `kernel/` (561 LOC). Workflows (420 LOC) require minor cleanup only. The ports layer deletes FC-specific guest ops. `sandbox-lifecycle.ts`, health routes, and system stats need rewrites but keep the same shape. The prebuild system keeps the same flow (temp env → init → snapshot → clone) but uses CSI VolumeSnapshots via TopoLVM instead of direct LVM commands — structurally identical, K8s-native API. Verdaccio moves from a managed host process to its own K8s Deployment. The manager never touches the host — everything is K8s API calls. No `sudo`, no shell-outs, no FFI.
