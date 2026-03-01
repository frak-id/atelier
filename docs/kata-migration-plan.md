# Kata Containers Migration Plan

_Last updated: 2026-03-01 — Phase 2 updated with guest-ops analysis, internal service layer, and service discovery_

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
│   │   ├── prebuild-runner.ts (~200 LOC) ← REWRITTEN (Kaniko Job orchestrator)
│   │   ├── sandbox-lifecycle.ts (~150 LOC) ← REWRITTEN (pod status monitoring)
│   │   └── sandbox-spawner.ts (99 LOC) ← UNCHANGED
│   └── infrastructure/
│       └── agent/            (~700 LOC, TCP transport)
├── Ingress controller (Traefik bundled with k3s, or nginx)
├── Zot registry (Deployment + PVC, cluster-internal OCI store)
├── Verdaccio (Deployment + PVC, npm package cache)
├── Kaniko (Job pods, in-cluster image builds — no Docker daemon)
├── Sandbox pods (runtimeClassName: kata-clh)
│   ├── Workspace image (base + prebuild baked in, per-workspace)
│   └── Slim agent (~1,500 LOC) → terminal, services, dev, git
└── Base images (dev-base, dev-cloud — OCI, with code-server + OpenCode baked in)
```

## What Changes Per Layer

### Kernel layer — REWRITE (561 LOC → ~300 LOC)

The kernel layer is the **only orchestrator code that touches Firecracker**. We rewrite it for K8s — same function signatures, different implementation. No abstraction layer, no interface — just replace the files.

| Current kernel file | What it does now | What it does after |
|---|---|---|
| `sandbox-boot.ts` (399) | allocate network → create LVM volume → launch FC → configure VM → boot → wait for agent → register Caddy/SSH routes | create Pod manifest → apply Pod + Service + Ingress → wait for pod Ready |
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
| `resizeStorage()` + `mknod` | LVM thin volumes need `resize2fs` after grow | OCI images define rootfs; PVCs handle dynamic storage |

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
| `storage/` — LVM, shared storage, ext4 image builder | 642 | Zot + OCI images (shared-binaries baked into base image) |
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

## OCI Prebuild System

Replaces the current LVM snapshot-based prebuild with a **two-layer OCI image** architecture. Prebuilds are baked into workspace images — no runtime init cost. The entire build pipeline runs inside the cluster via **Kaniko** — zero host-level tooling.

### Two-Layer Image Architecture

```
Layer 1 — Base image (shared, rarely rebuilt)
  ├── dev-base:latest    Node 22, Bun, code-server, OpenCode, common tooling
  └── dev-cloud:latest   dev-base + AWS CLI, gcloud, kubectl

Layer 2 — Workspace image (per-workspace, rebuilt on trigger)
  └── workspace-{id}:{commit-hash}
      FROM dev-base:latest (or dev-cloud)
      → git clone repos at pinned commits
      → run init commands (npm install, build, etc.)
      → fix ownership, cleanup caches
```

**Image size:** code-server (~120MB) and OpenCode are baked into the base image. Since all workspace images `FROM dev-base`, containerd's layer deduplication stores the base layer only once on disk. Each workspace image only adds workspace-specific content (repos, deps). No explicit shared volume needed — OCI layer sharing handles it for free.

### Prebuild Flow: Current vs After

| Step | Current (LVM) | After (OCI + Kaniko) |
|---|---|---|
| **1. Start** | Spawn temp Firecracker VM | Generate Dockerfile from workspace config |
| **2. Build context** | Wait for agent, clone repos | Create ConfigMap with Dockerfile + K8s Secret with git auth |
| **3. Build** | Run init commands via agent exec | Create Kaniko Job pod → builds image inside cluster |
| **4. Store** | LVM snapshot of VM's volume | Kaniko pushes image to Zot registry |
| **5. Capture** | Record commit hashes from inside VM | Record commit hashes at build time (from Kaniko Job output) |
| **6. Cleanup** | Destroy temp VM | Job pod auto-cleaned by K8s (TTL) |
| **On spawn** | Clone LVM snapshot → boot FC from it (1.5-2.5s) | Create pod from workspace image in Zot (~200-300ms) |

Key differences:
- **Zero host access** — no Docker daemon, no shell-outs, no FFI. Manager only talks K8s API.
- **Reproducible** — same Dockerfile = same image. No "works on my snapshot" issues.
- **Cacheable** — Kaniko supports layer caching via a cache repo in Zot. If only code changed (new commit) but deps didn't, `npm install` layer is cached.
- **No runtime init cost** — deps already installed, code already cloned. Pod boots straight into ready state.

### Prebuild Triggers

Same triggers as current system, adapted for OCI:

| Trigger | Detection | Action |
|---|---|---|
| **Commit hash change** | Cron polling via `git ls-remote` (every 30min, same as current `PrebuildChecker`) | Create Kaniko Job to rebuild workspace image with new commits |
| **Base image update** | Detect when `dev-base` or `dev-cloud` is rebuilt (image digest change in Zot) | Rebuild all workspace images that depend on it |
| **Manual trigger** | `POST /:id/prebuild` API endpoint (same as current) | Create Kaniko Job to rebuild workspace image on demand |

The `PrebuildChecker` stays mostly unchanged — it still polls `git ls-remote` and compares hashes. The difference is that on stale detection, it triggers a Kaniko Job instead of a VM-based snapshot.

### Generated Dockerfile (example)

```dockerfile
FROM zot.atelier-system.svc:5000/dev-base:latest

# Clone repos at specific commits
RUN --mount=type=secret,id=git_token \
    git clone --branch main https://x-access-token:$(cat /run/secrets/git_token)@github.com/org/repo.git /home/dev/workspace/repo \
    && cd /home/dev/workspace/repo \
    && git checkout abc123def

# Run init commands from workspace config
WORKDIR /home/dev/workspace
RUN npm install
RUN npm run build

# Fix ownership
RUN chown -R dev:dev /home/dev
```

Auth tokens are passed as build secrets (`--secret`), never baked into image layers.

### Build & Registry Infrastructure

#### Zot Registry (cluster-internal OCI store)

[Zot](https://zotregistry.dev/) is an OCI-native registry (~15MB binary, ~30MB idle RAM). Deployed as a Deployment + PVC inside the cluster.

```yaml
# Deployed via Helm chart in atelier-system namespace
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
            claimName: zot-data  # local-path or hostPath PVC
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

Cluster-internal only — no external exposure, no auth needed. Accessible at `zot.atelier-system.svc:5000`.

k3s containerd must be configured to pull from it as an insecure (HTTP) registry:

```yaml
# /etc/rancher/k3s/registries.yaml (part of Helm chart setup)
mirrors:
  "zot.atelier-system.svc:5000":
    endpoint:
      - "http://zot.atelier-system.svc:5000"
```

**What lives in Zot:**

| Image | Tag | Rebuilt when |
|---|---|---|
| `dev-base` | `latest` + date tag | Base image updated (manual or CI) |
| `dev-cloud` | `latest` + date tag | Base image updated (manual or CI) |
| `workspace-{id}` | `{short-commit-hash}` | Prebuild triggered |
| `cache` | (layer blobs) | Automatically by Kaniko `--cache-repo` |

#### Kaniko (in-cluster image builder)

[Kaniko](https://github.com/GoogleContainerTools/kaniko) builds OCI images inside a K8s pod — no Docker daemon, no privileged mode, no host access. The manager creates a **Job** for each prebuild.

```yaml
# Created by manager's prebuild-runner.ts via K8s API
apiVersion: batch/v1
kind: Job
metadata:
  name: prebuild-{workspace-id}-{short-hash}
  namespace: atelier-system
  labels:
    atelier.dev/component: prebuild
    atelier.dev/workspace: "{workspace-id}"
spec:
  ttlSecondsAfterFinished: 300  # auto-cleanup after 5min
  backoffLimit: 0                # no retries — fail fast
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: kaniko
          image: gcr.io/kaniko-project/executor:latest
          args:
            - "--dockerfile=/workspace/Dockerfile"
            - "--context=dir:///workspace"
            - "--destination=zot.atelier-system.svc:5000/workspace-{id}:{hash}"
            - "--cache=true"
            - "--cache-repo=zot.atelier-system.svc:5000/cache"
            - "--insecure"          # Zot is HTTP-only (cluster-internal)
            - "--skip-tls-verify"
          volumeMounts:
            - name: dockerfile
              mountPath: /workspace
            - name: git-secret
              mountPath: /kaniko/.docker/
              readOnly: true
      volumes:
        - name: dockerfile
          configMap:
            name: prebuild-{workspace-id}-{short-hash}  # contains generated Dockerfile
        - name: git-secret
          secret:
            secretName: atelier-git-credentials  # git auth for private repos
```

**Wiring — how the manager orchestrates a prebuild:**

```
1. Trigger fires (commit change / base image / manual)
         │
2. Manager generates Dockerfile from workspace config
   (repos, branches, init commands, base image)
         │
3. Manager creates ConfigMap with Dockerfile content
   (kubectl apply configmap prebuild-{id}-{hash})
         │
4. Manager creates Kaniko Job (spec above)
   (kubectl apply job prebuild-{id}-{hash})
         │
5. Manager watches Job status via K8s API
   ├── Job succeeds → image is in Zot at workspace-{id}:{hash}
   │   ├── Update workspace config with new image ref + commit hashes
   │   ├── Mark prebuild status "ready"
   │   └── Cleanup: delete ConfigMap (Job auto-deletes via TTL)
   │
   └── Job fails → read pod logs for error details
       ├── Mark prebuild status "failed"
       └── Emit prebuild.failed event with error context
         │
6. New sandboxes use: image: zot.atelier-system.svc:5000/workspace-{id}:{hash}
```

All steps are pure K8s API calls. No host access, no Docker socket, no shell-outs.

### Prebuild Runner Rewrite

The current `PrebuildRunner` (641 LOC) gets rewritten (~200 LOC):

| Current responsibility | After |
|---|---|
| Spawn temp VM via `SandboxSpawner` | Generate Dockerfile + create ConfigMap |
| Run init commands via agent exec | Init commands are Dockerfile RUN steps |
| Capture commit hashes via agent exec | Resolve via `git ls-remote` before build, tag image with hash |
| Warmup OpenCode inside VM | Warmup happens at pod boot (or skipped — pod starts fast enough) |
| Push auth/configs via agent | Auth as K8s Secret mounted in Kaniko, configs as ConfigMap |
| `StorageService.createPrebuild()` (LVM snapshot) | Create Kaniko Job → image pushed to Zot |
| Cleanup: destroy temp VM | Job auto-deletes via TTL, ConfigMap deleted on completion |

The `PrebuildChecker` (133 LOC) stays mostly unchanged — same `git ls-remote` polling, same staleness logic. Only the action on stale changes: create Kaniko Job instead of spawning a VM.

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

Cloud Hypervisor is Kata's default VMM. The ~75ms boot penalty is negligible — sandbox pods boot from pre-built workspace images with everything already installed.

## New Code Required

| Component | LOC | Language |
|---|---|---|
| `kernel/sandbox-boot.ts` — pod lifecycle | ~200-250 | TypeScript |
| `kernel/boot-waiter.ts` — pod readiness | ~40 | TypeScript |
| `kernel/cleanup-coordinator.ts` — pod deletion | ~30 | TypeScript |
| `sandbox-lifecycle.ts` — pod status monitoring | ~150 | TypeScript |
| `prebuild-runner.ts` — Dockerfile generator + Kaniko Job orchestrator | ~200 | TypeScript |
| `health.routes.ts` — K8s health checks | ~50 | TypeScript |
| `system.routes.ts` — K8s metrics stats | ~30 | TypeScript |
| Helm chart (manager, Zot, Verdaccio, RBAC, RuntimeClass, Ingress, Kaniko RBAC) | ~400 | YAML |
| Base image Dockerfile (from dev-base rootfs, with code-server + OpenCode baked in) | ~80 | Dockerfile |
| Agent transport (vsock→TCP, ~50 LOC net change) | ~50 | TypeScript |
| **Total new** | **~1,230-1,280** | |

## K8s Overhead on Single VPS

| Component | Idle RAM | Idle CPU |
|---|---|---|
| **k3s (stripped)** | ~1,200-1,400MB | 5% of 1 core |
| **Zot registry** | ~30MB | negligible |
| **Verdaccio** | ~80MB | negligible |
| **Kaniko** | 0 (Job pods, only runs during builds) | 0 |
| **Total overhead** | ~1,310-1,510MB | ~5% of 1 core |

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

### Phase 2: Rewrite Core (2-3 weeks)

- Add `@kubernetes/client-node` to manager
- **Kernel layer rewrite:**
  - Rewrite `kernel/sandbox-boot.ts` — `bootNewSandbox()` creates Pod + Service + Ingress via K8s API, pod image pulled from Zot
  - Rewrite `kernel/boot-waiter.ts` — watch pod status instead of polling FC process
  - Rewrite `kernel/cleanup-coordinator.ts` — label-based bulk delete
- **Sandbox lifecycle rewrite:**
  - Rewrite `sandbox-lifecycle.ts` — pod status monitoring replaces `kill -0` process checks, socket checks, vsock repair
- **Prebuild rewrite:**
  - Rewrite `prebuild-runner.ts` — generates Dockerfile, creates ConfigMap + Kaniko Job, watches Job completion, updates workspace config with image ref
  - Adapt `prebuild-checker.ts` — same trigger logic, calls Kaniko-based runner instead of VM-based runner
- **Agent transport:**
  - Update `agent.client.ts` — replace vsock transport with TCP (pod IP from K8s API)
  - Slim agent: remove health, config, vsock endpoints
- **Guest ops cleanup (FC-specific operations deleted — K8s handles natively):**
  - Delete `buildDnsCommand()` — CoreDNS handles pod DNS
  - Delete `buildClockSyncCommand()` — Cloud Hypervisor `kvmclock` validated in Phase 1 (no drift)
  - Delete `buildHostnameCommand()` — K8s pod spec `hostname` field
  - Delete `buildSwapCommand()` — K8s memory requests/limits replace manual swap
  - Delete `resizeStorage()` + `mknod` commands — OCI images handle rootfs natively
  - Delete `buildMountSharedBinariesCommand()` — binaries baked into base OCI image
- **Workflow cleanup (~10 LOC per file, 4 files):**
  - Remove deleted guest-ops calls from `create-workspace.ts`, `create-system.ts`, `restart-workspace.ts`, `restart-system.ts`
  - Remove `agent.setConfig()` calls — replaced by ConfigMap mounted at pod creation
- **Service discovery URL migration (~20 LOC):**
  - Replace `config.network.bridgeIp` references with K8s service DNS names
  - Update `RegistryService.getRegistryUrl()` → `http://verdaccio.atelier-system.svc:4873`
  - Update `SandboxConfig.managerUrl` → `http://manager.atelier-system.svc:4000`
  - Update `pushRegistryConfig()` — npm/bun/yarn configs point to K8s Verdaccio service
- **Health & system stats:**
  - Rewrite `health.routes.ts` — check K8s API, Zot, Kata RuntimeClass instead of FC/LVM/Caddy
  - Rewrite system stats in `system.routes.ts` + `mcp/tools/system.ts` — K8s metrics API instead of `top`/`free`/`df`
- **Cleanup:**
  - Delete `shared/lib/shell.ts` — all FC/host-specific helpers
- **Internal service layer: NO CHANGES** — auth sync, config sync, registry sync, poller all transport-agnostic
- **Testing:**
  - Test end-to-end: API → pod created → ingress works → agent reachable → terminal works
  - Test prebuild: trigger → Kaniko Job → image in Zot → new sandbox uses prebuilt image
  - Test auth sync: authenticate in sandbox A → verify token appears in sandbox B within 5s
  - Test config sync: update config from dashboard → verify pushed to all running sandboxes
  - Test registry sync: enable/disable registry → verify npm config updated in all sandboxes
- **Exit criteria**: Full sandbox lifecycle + prebuild + auth/config sync works on K8s, zero host-level operations

### Phase 3: Helm + Cleanup (1-2 weeks)

- Write Helm chart: manager Deployment + PVC, RBAC, RuntimeClass, Ingress defaults, Zot Deployment + PVC + Service, Verdaccio Deployment + PVC + Service + ConfigMap, Kaniko ServiceAccount + RBAC, containerd registries.yaml config
- Delete old code:
  - `infrastructure/firecracker/` (277 LOC)
  - `infrastructure/network/` (274 LOC)
  - `infrastructure/proxy/` (827 LOC)
  - `infrastructure/storage/` (642 LOC)
  - `infrastructure/registry/` (451 LOC) — host process management
  - `shared/lib/shell.ts` (105 LOC)
  - `apps/cli/` (3,141 LOC)
- Write migration guide for existing bare-metal users
- **Exit criteria**: `helm install` on fresh k3s cluster, everything works

### Phase 4: Ship (1 week)

- Final testing on production server
- Update README, docs, quickstart
- Deploy to production
- Decommission old bare-metal setup

**Total: 5-8 weeks**

## Future Unlocks

- **Warm pool**: Pre-spawn 1 pod per workspace from its workspace image. Pod sits idle with minimal resources (0.5 CPU, 512Mi). On claim, hot-plug CPU + memory via `InPlacePodVerticalScaling` (K8s 1.35+, Cloud Hypervisor). Reduces spawn time from ~200-300ms cold boot to ~50-100ms claim. Requires: pool controller (~150 LOC), replenishment logic, resource scaling. Nice-to-have once core migration is stable.
- **SSH proxy pod**: If devs need `ssh sandbox-id@host` with key rotation (current sshpiper feature), deploy sshpiper as a small K8s Deployment that proxies SSH to sandbox pods. For now, `kubectl exec` + dashboard WebSocket terminals cover the use case.
- **Multi-node**: Join a second k3s node. K8s scheduler places sandboxes automatically. Zot already handles image distribution — nodes pull from it.
- **Operator (if needed)**: Extract sandbox lifecycle into CRD + reconciler when manager-as-controller pattern breaks down (HA, complex warm pools, `kubectl get sandboxes` observability).
- **Language**: Operator would be Rust (kube-rs), shared crates with agent.

## Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Boot time regression with Kata | LOW | Current boot is 1.5-2s with full LVM + FC setup. Kata cold boot from prebuilt workspace image: ~200-300ms — a significant improvement. |
| K8s overhead on small VPS | LOW | k3s stripped + Zot + Verdaccio = ~1.5GB. Acceptable on 16GB+. |
| Network policy limitations (Kata TC model) | LOW | Test with chosen CNI. Basic routing works fine. |
| Cloud Hypervisor less battle-tested than FC | LOW | It's Kata's default. Northflank uses it in production. |
| Image build time for large workspaces | LOW | Kaniko layer caching via Zot cache repo. Code-only changes (new commit, same deps) rebuild in seconds. |
| Kaniko build failures | LOW | Manager reads Job pod logs on failure, surfaces error in prebuild status. `backoffLimit: 0` means fail fast, no silent retries. |
| Zot registry data loss | LOW | PVC on local-path storage. For critical setups, back up PVC or rebuild images from Dockerfiles (reproducible). |
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
| Prebuild runner (Kaniko orchestrator) | ~200 |
| Health routes + system stats (K8s API) | ~80 |
| Registry client (HTTP to Verdaccio) | ~50 |
| Helm chart (manager + Zot + Verdaccio + RBAC + Kaniko) | ~400 |
| Dockerfiles (base + workspace template) | ~80 |
| Agent transport change | ~50 |
| **Total new** | **~1,310** |

### Net result

| | Before | After | Delta |
|---|---|---|---|
| Manager (infra + orchestrators) | ~7,555 | ~3,754 | -3,801 |
| CLI | 3,141 | 0 | -3,141 |
| Agent | 3,040 | ~1,500 | -1,540 |
| Infra scripts | 480 | ~250 | -230 |
| **Total** | **~14,216** | **~5,504** | **-8,712** |

### Key insight

The hexagonal refactor isolated all FC-specific code into `kernel/` (561 LOC). Workflows (420 LOC) require zero changes. The ports layer gets a minor cleanup (remove FC device commands). `sandbox-lifecycle.ts`, health routes, and system stats need rewrites but keep the same shape. The prebuild system changes form (LVM snapshots → Kaniko + Zot) but keeps the same trigger logic. Verdaccio moves from a managed host process to its own K8s Deployment. The manager never touches the host — everything is K8s API calls. No `sudo`, no shell-outs, no FFI.
