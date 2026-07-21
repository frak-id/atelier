# Fast-Boot & Snapshot/Prebuild Economics with Per-Instance Config Variance

> **Research focus:** How do sandbox/serverless platforms maintain sub-10 s (often sub-1 s) boot while allowing arbitrary per-sandbox configuration, without a snapshot-per-config combinatorial explosion?
>
> Written: 2025-07 | Sources cited inline

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Technology Deep-Dives](#2-technology-deep-dives)
   - [Firecracker Snapshot/Restore](#21-firecracker-snapshotrestore)
   - [CRIU Checkpoint/Restore](#22-criu-checkpointrestore)
   - [gVisor Checkpoint/Restore](#23-gvisor-checkpointrestore)
   - [E2B Templates + Snapshots](#24-e2b-templates--snapshots)
   - [Modal Memory Snapshots](#25-modal-memory-snapshots)
   - [Kata Containers](#26-kata-containers)
   - [OverlayFS / Devicemapper Layering](#27-overlayfs--devicemapper-layering)
   - [Gitpod & Coder Prebuilds](#28-gitpod--coder-prebuilds)
   - [Nix Store Sharing](#29-nix-store-sharing)
   - [Copy-on-Write Volumes (TopoLVM / LVM Thin)](#210-copy-on-write-volumes-topolvm--lvm-thin)
   - [AWS Lambda / SOCI Lazy Pull](#211-aws-lambda--soci-lazy-pull)
3. [Techniques Reference Table](#3-techniques-reference-table)
4. [Key Questions Answered](#4-key-questions-answered)
5. [Recommended Model](#5-recommended-model)
6. [Config Classes That CANNOT Be Overlaid](#6-config-classes-that-cannot-be-overlaid)
7. [References](#7-references)

---

## 1. Executive Summary

All fast-boot platforms converge on the same core insight:

> **Bake the expensive, shared, stable work into a snapshot/image. Apply the cheap, per-instance, variable config as an overlay or environment injection at resume time.**

The key to avoiding a snapshot-per-config matrix is **content-addressed layering**: the snapshot key is derived from the stable base, not from the full config space. Per-user differences are expressed as thin writable layers (OverlayFS upperdir), environment variables, bind-mounts, or post-resume init scripts — none of which require a new base snapshot.

Platforms achieve sub-10 s (often < 200 ms) boot through a combination of:
- **Lazy memory loading** (MAP_PRIVATE + UFFD page faults served on demand)
- **Shared read-only memory files** (many resumed VMs, one immutable snapshot backing file)
- **OverlayFS lower-layer sharing** (hundreds of containers share the same rootfs layers in page cache)
- **Process-level freeze** (CRIU/gVisor): skip Python import / JVM class-loading on every boot
- **Optimized base images** (minimal kernel, masked slow systemd units)

---

## 2. Technology Deep-Dives

### 2.1 Firecracker Snapshot/Restore

**Source:** [Firecracker snapshot-support.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)

#### What a snapshot contains
A Firecracker snapshot is **three separable artifacts**:
1. **`mem_file`** — full guest RAM image (all pages for full snapshot; only dirtied pages for diff snapshot)
2. **`snapshot_file`** — serialized device model + KVM vCPU state (registers, MSRs, interrupt controllers, etc.)
3. **Block device files** — managed externally by the operator; Firecracker does NOT include them in the snapshot

#### Full vs. diff snapshots
| Type | Contents | Resume-able? | Use case |
|------|----------|-------------|----------|
| Full | Entire guest memory + device state | Yes | Base snapshot for cloning |
| Diff | Dirty pages since last snapshot + device state | Generally no (must rebase); exception: diff of booted VM is immediately resumable | Incremental saves, tiered snapshotting |

Diff snapshots are merged with: `snapshot-editor edit-memory rebase --memory-path <base> --diff-path <layer>`

#### Lazy memory loading at resume
On `LoadSnapshot`, Firecracker creates a **`MAP_PRIVATE` mapping** of the `mem_file`. Pages are loaded on-demand by the OS page-fault handler — the VM resumes before memory is fully loaded. Writes go to anonymous CoW memory, leaving the backing file immutable.

**Critical implication:** The backing `mem_file` can be shared read-only across **many simultaneously-running clone VMs**. Each clone sees its own CoW anonymous layer for writes. This is the key to one-snapshot-many-sandboxes.

#### UFFD (User Fault FD) page serving
Alternatively, `backend_type: "Uffd"` hands page-fault handling to a userspace daemon, enabling:
- **Priority-aware prefetch** (load hot pages first)
- **Network-served pages** (snapshot stored remotely, fetched on demand)
- **Custom eviction policies**

This is how platforms like E2B achieve sub-second resume even when snapshot files are stored on network storage — the VM starts immediately, and pages trickle in over the network as they are accessed.

#### Snapshot granularity / key
Firecracker does not define a snapshot key. The integrator decides. Best practice is:
- **Key = (kernel version, rootfs content hash, init state reached)** — e.g., "Ubuntu 22.04 + Python 3.11 + pip packages installed, daemon started, ready to accept work"
- Per-user differences (env vars, user ID, project files) are applied **after resume** via the guest agent

#### Network connectivity
Network state is NOT preserved across snapshot/restore. Connections drop. TAP interfaces must be re-established. This is a fundamental limitation — any protocol-level sessions must be re-established post-resume.

#### Cloning security
Resumed-from-same-snapshot VMs share identical entropy state at resume point. Firecracker injects a VMGenID update pre-resume, causing Linux ≥ 5.18 to re-seed its CSPRNG. User-space random state (cached UUIDs, tokens) is NOT de-duplicated and must be handled by the application.

---

### 2.2 CRIU Checkpoint/Restore

**Source:** [criu.org](https://criu.org/Checkpoint/Restore), [CRIU + Docker LPC 2020](https://lpc.events/event/7/contributions/643/attachments/540/958/LPC_2020_Docker_CRIU.pdf)

CRIU ("Checkpoint/Restore In Userspace") freezes a running Linux container by:
1. Seizing all processes in the container via `ptrace`
2. Reading `/proc/<pid>/maps`, `smaps`, `fd`, `cgroup`, `ns` to collect complete process state
3. Serializing memory pages, file descriptors, sockets, signal handlers, timers to disk
4. On restore: re-creating namespaces, remapping memory, re-opening FDs, re-injecting signal state

#### OverlayFS interaction
CRIU captures OverlayFS mount parameters (lowerdir, upperdir, workdir). On restore, the same OverlayFS mount must be re-established with identical paths. The read-only lower layers can be shared with other containers — they are not copied. Only the upperdir (per-container writes) is unique.

#### Lazy pages (UFFD)
CRIU supports `--lazy-pages`: memory pages are not written to the checkpoint image eagerly. On restore, a `lazy-pages` daemon serves pages on demand via UFFD as the restored process faults them in. This makes checkpoint files small and restore fast.

#### Limitations with containers
- Open TCP connections cannot be restored (unless the kernel is patched with TCP repair mode)
- GPU state is not captured
- OverlayFS paths must match on restore host
- CRIU requires host kernel cooperation; does not work inside standard rootless containers

---

### 2.3 gVisor Checkpoint/Restore

**Sources:** [gVisor checkpoint/restore docs](https://gvisor.dev/docs/user_guide/checkpoint_restore/), [gVisor filesystem snapshots](https://gvisor.dev/docs/user_guide/fs_snapshot/), [gVisor PR #13537](https://github.com/google/gvisor/pull/13537)

gVisor (`runsc`) implements Linux in userspace. Its checkpoint/restore is **implemented inside the userspace kernel itself** — not via host kernel `/proc` introspection like CRIU.

#### What is checkpointed
- Full process tree state: memory mappings, registers, file descriptors, environment
- Virtual filesystem state (VFS2 layer)
- Network state (gVisor implements its own TCP/IP stack — netstack — which IS checkpointable)
- **Not checkpointed:** NVIDIA GPU state (requires `cuda-checkpoint` integration, separate flow)

#### Filesystem snapshots (separate from process snapshots)
gVisor v2024+ supports **filesystem-only snapshots** (`--fs-restore-image-path`):
- Save mutations to the container rootfs without freezing the process tree
- Restore filesystem state into a **new sandbox** on next `runsc run`
- Enables: "bake a filesystem state at a known point, restore it cheaply for many fresh sandboxes"

This is complementary to full checkpoint: use filesystem snapshots to avoid reinstalling packages; use full process checkpoints to avoid Python import overhead.

#### Application-driven checkpoints
PR #13537 added `/proc/gvisor/checkpoint` — writing `1` triggers a checkpoint from inside the sandbox without an external `runsc checkpoint` call. This enables self-snapshotting at application-defined ready points.

---

### 2.4 E2B Templates + Snapshots

**Sources:** [E2B template docs](https://e2b.dev/docs/template/how-it-works), [E2B infra cold boot PR #3020](https://github.com/e2b-dev/infra/commit/f05ccea7aab62252948173a71a83f19c12f919b5), [E2B docs snapshot comparison](https://github.com/e2b-dev/docs/commit/25ebcf4aa9fcc072bd11bf88383d3fd4151cd3d2)

E2B advertises ~150 ms sandbox starts from templates.

#### Template lifecycle
1. User writes `e2b.Dockerfile` (standard Dockerfile syntax)
2. E2B CLI builds it → extracts filesystem → installs dependencies → runs provisioning commands
3. Optionally executes a `start_command` and waits for readiness (up to 20 s)
4. **Takes a Firecracker microVM snapshot** of the entire state (memory + disk + device state)
5. Stores the snapshot; assigns a `template_id`

#### Cold boot optimization (PR #3020)
Before snapshotting, E2B optimizes guest boot with:
- Masking slow systemd units: `chrony-wait` (8 s gate on `multi-user.target`), `systemd-binfmt` (1 s), `e2scrub_reap` (LVM-only)
- Pre-packing CA certs into the tarball consumed by `envd.service`
- Adding `makestep 1.0 3` to chrony for instant clock sync
- Result: filesystem-only (reboot) resume: 9.5 s → **0.5 s**

#### Templates vs. Snapshots (two different things in E2B)
| | Templates | Snapshots |
|--|-----------|-----------|
| Defined by | Declarative `e2b.Dockerfile` | Capturing a running sandbox mid-execution |
| Reproducibility | Same definition → same result | Captures live state (non-reproducible) |
| Use case | Reusable base environment | "Save and resume" individual session |
| How started | Restore from baked Firecracker snapshot | Restore from live-captured snapshot |

#### Per-config handling
E2B templates are **one-per-base-config**. Per-user differences are applied post-resume:
- Environment variables injected by the `Sandbox(env={...})` SDK call
- User files uploaded via the filesystem API after sandbox starts
- Runtime `sudo` commands executed inside the running sandbox (instant, no snapshot rebuild)

---

### 2.5 Modal Memory Snapshots

**Source:** [Modal blog: Memory Snapshots](https://modal.com/blog/mem-snapshots), [Modal GPU Snapshots](https://modal.com/blog/gpu-mem-snapshots)

Modal uses **gVisor (`runsc`)** as its container runtime (for security isolation). Memory snapshots leverage gVisor's checkpoint/restore.

#### What is captured
- Entire process tree frozen at the point **just before accepting the first request**
- Memory mappings (all pages, including Python bytecode cache, imported module state)
- File descriptor table, environment, PIDs, signal handlers
- Filesystem mutations via OverlayFS upperdir (captured in filesystem state)
- **NOT captured:** NVIDIA GPU VRAM (must be re-initialized post-restore)

#### Filesystem architecture
Modal containers use **OverlayFS** where:
- **Lower (read-only):** FUSE-based lazy-loading file server (container image layers fetched from distributed store on demand)
- **Upper (read-write):** Per-container mutations (pip installs, file writes during setup)

The "pages file" (memory snapshot) references the same FUSE lower layer — on restore, pages that reference lower-layer files benefit from the layer already being in page cache on the host (pre-loaded aggressively before resume).

#### Performance
- Import `torch` (26,000 syscalls normally): 5 s cold → **~1.05 s p50 / 0.69 s p0** with snapshot
- Stable Diffusion inference Function: 13 s cold → **3.5 s** with snapshot
- ~2.5× faster cold starts across the board

#### Snapshot key / lifecycle
- Snapshots are **CPU architecture + driver version + container runtime version** sensitive
- Modal manages the lifecycle automatically: detects when a redeploy invalidates a snapshot, recreates on-demand
- A single Function version may have **multiple snapshots** (one per worker host type, due to CPU feature set incompatibility — e.g., `pclmulqdq` instruction not available on all instance types)

#### GPU handling
GPU state cannot be snapshotted in the general case. The Modal pattern:
```python
@app.cls(enable_memory_snapshot=True)
class Model:
    @modal.enter(snap=True)   # runs BEFORE snapshot, result baked in
    def load_to_cpu(self):
        self.model = load_model_to_cpu()
    
    @modal.enter(snap=False)  # runs AFTER restore, not baked
    def move_to_gpu(self):
        self.model = self.model.to("cuda")
```
The split entry point is the canonical pattern for anything that can't be snapshotted.

---

### 2.6 Kata Containers

**Sources:** [Kata architecture](https://github.com/kata-containers/kata-containers/blob/main/docs/design/architecture.md), [EROFS snapshotter](https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-use-erofs-snapshotter-with-kata.md), [per-sandbox config](https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-set-sandbox-config-kata.md)

Kata Containers run each pod in a lightweight VM (QEMU, Cloud Hypervisor, or Firecracker backend). They do NOT use CRIU/process snapshots by default — instead they rely on **fast VM boot** (~100 ms with optimized kernels).

#### Layer architecture inside guest
```
Host                          Guest VM
════                          ════════
containerd
kata-agent
  |
  v
EROFS snapshotter
  |-- Mount[0]: ext4 rw layer    ← writable upper (per-container)
  |   (block device on host)
  |-- Mount[1]: erofs layers     ← read-only lower layers (shared)
  |   source: layer.erofs
  v
overlay mount inside guest:
  lowerdir=<erofs_mount>
  upperdir=<ext4_mount>/upper
  workdir=<ext4_mount>/work
```

The guest-internal overlayfs presents the normal container rootfs. EROFS (read-only) layers can be shared across pods on the same host — identical lower layers hit the same page cache entries.

#### Per-sandbox config mechanism
Kata accepts per-pod configuration via OCI spec annotations (`io.katacontainers.*`):
- Kernel parameters
- CPU/memory sizes
- Extra bind-mounts (`SandboxBindMounts`)
- SELinux labels
- Custom hypervisor config path

None of these require a separate VM snapshot — they are injected at VM creation time (boot-time parameters).

#### Nydus/guest-pull image loading
With Nydus snapshotter, Kata supports **lazy image pulling inside the guest**: image layers are fetched from a registry on-demand as file data is accessed (FUSE-based inside the guest). This means a sandbox can start running before the full image is downloaded.

---

### 2.7 OverlayFS / Devicemapper Layering

**Sources:** [Linux kernel overlayfs docs](https://docs.kernel.org/filesystems/overlayfs.html), [Docker overlayfs driver](https://docs.docker.com/engine/storage/drivers/overlayfs-driver/), [containerd book ch6](https://thecontainerdbook.com/chapters/part-2/06-filesystems)

OverlayFS is the foundational mechanism enabling layer sharing across containers.

#### Structure
```
Container N:     [ upperdir_N (rw, per-container) ]
                 [ lowerdir_3 (ro, shared)         ]  ← same physical pages
Container M:     [ upperdir_M (rw, per-container) ]      for all containers
                 [ lowerdir_3 (ro, shared)         ]      using this image
                 [ lowerdir_2 (ro, shared)         ]
                 [ lowerdir_1 (ro, shared)         ]
```

- **Lower layers** are read-only and shared among all overlay mounts using them. The Linux page cache deduplicates: if 100 containers share the same lower layer, only one copy exists in RAM.
- **Upper layer** (upperdir) is per-container writable. It starts empty. On first write to a shared file, the file is **copy-up**'d to the upper layer — this adds latency only on first write.
- **Multiple lower layers** are supported (stacked, separated by `:`). Order matters: upper layers shadow lower layers.

#### Copy-up latency
Copy-up occurs synchronously on first write to a lower-layer file. For large files this can be slow. Mitigation:
- Use `metacopy` mount option (copy metadata only, defer data copy)
- Structure images so frequently-written files are in the upper layer from the start

#### Devicemapper thin provisioning
Docker's legacy devicemapper driver used LVM thin pools:
- Each image layer = a thin snapshot of the previous layer
- Each container = a thin snapshot of the top image layer
- CoW at **block** level (512 B granularity) rather than file level
- Advantages: works for any filesystem inside; more predictable latency
- Deprecated in Docker (OverlayFS is preferred)

---

### 2.8 Gitpod & Coder Prebuilds

**Sources:** [Gitpod PVC prebuilds PR #10689](https://github.com/gitpod-io/gitpod/pull/10689), [Coder prebuilt workspaces](https://coder.com/docs/admin/templates/extending-templates/prebuilt-workspaces), [Coder blog 2025](https://coder.com/blog/launch-week-2025-instant-infrastructure)

#### Gitpod prebuild model
Gitpod prebuilds run workspace `init` tasks (e.g., `npm install`, `cargo build`) in the background triggered by git push. The result is stored as a **Kubernetes VolumeSnapshot** (backed by PVC).

When a developer opens the workspace:
1. A new PVC is created from the VolumeSnapshot (CoW clone — instant, no data copy)
2. The workspace container starts with the pre-built state mounted
3. Only `command` tasks (e.g., `npm start`) run; `init` tasks are skipped

**Key point:** The prebuild snapshot is **repo+branch-keyed**, not user-keyed. Many users opening the same branch get a CoW clone of the same snapshot.

#### Coder prebuilt workspaces (2025)
Coder's model is Terraform-based:
```hcl
data "coder_workspace_preset" "goland" {
  name = "GoLand: Large"
  parameters = {
    jetbrains_ide = "GO"
    cpus = 8
    memory = 16
  }
  prebuilds {
    instances = 3   # keep 3 warm instances ready
  }
}
```
Prebuilt instances are created ahead of time (infra provisioned, workspace agent started). When a user claims one, Coder re-assigns ownership. No boot time — the instance is already running.

**Per-user config** (user identity, git credentials, dotfiles) is applied **after claiming** by the workspace agent, not baked into the prebuilt.

---

### 2.9 Nix Store Sharing

**Sources:** [Nix package manager wiki](https://wiki.nixos.org/wiki/Nix_%28package_manager%29/en), [Nix content-addressing](https://releases.nixos.org/nix/nix-2.34.0/manual/store/store-object/content-address.html), [Nix local chroot store](https://releases.nixos.org/nix/nix-2.31.1/manual/store/types/local-store.html)

#### How Nix prevents combinatorial explosion
Nix packages are stored at `/nix/store/<hash>-<name>` where `<hash>` is derived from:
- All inputs (source, dependencies, build script, environment)
- The content-addressed output (for CA derivations)

Two sandboxes with different configs but sharing packages like `python3.11` or `nodejs20` will share the **exact same store paths** — no duplication. The store is globally read-only and shared across all users/sandboxes on the same host via bind-mount.

#### Sandbox integration patterns
- **Read-only bind-mount** `/nix/store` into each sandbox: instant, zero copy, shared page cache
- **Nix profiles per user**: a symlink tree in `~/.nix-profile` → store paths; user-specific without copying packages
- **`nix develop` shells**: generate a shell environment from a `flake.nix`; packages already in store (pre-built or cached) → shell starts in milliseconds

#### What CAN'T be shared via Nix
- Packages not yet built (first build takes full time)
- Packages requiring `allowUnfree` or custom patches (different hash = different store path, not shared with others)
- CUDA libraries tied to specific driver versions (hash changes with driver)

---

### 2.10 Copy-on-Write Volumes (TopoLVM / LVM Thin)

**Sources:** [TopoLVM README](https://github.com/topolvm/topolvm), [TopoLVM thin volumes proposal](https://github.com/topolvm/topolvm/blob/main/docs/proposals/thin-volumes.md), [TopoLVM snapshot PR #738](https://github.com/topolvm/topolvm/pull/738)

TopoLVM is a Kubernetes CSI plugin using LVM for node-local persistent volumes.

#### Thin provisioning + snapshots
```
Thin pool (e.g., 1 TB)
  ├── Base LV (prebuild content, ~10 GB)
  │   ├── Snapshot LV A (user Alice, CoW, initially 0 B extra)
  │   ├── Snapshot LV B (user Bob,  CoW, initially 0 B extra)
  │   └── Snapshot LV C (user Carol, CoW, initially 0 B extra)
```
Creating a thin snapshot is **instantaneous** (metadata operation only). Actual storage is consumed only as each user writes different data.

#### Limitations
- Snapshots can only be created from **thin volumes** (not regular LVs)
- Snapshots are **node-local** — cannot be restored on a different node (violates Kubernetes scheduling flexibility)
- Resizing snapshots to be larger than source is a recent addition (PR #738)

#### Use for workspace prebuilds
Pattern: run a prebuild on Node A, create a thin snapshot LV. Any workspace claiming that prebuild must be scheduled to Node A (node affinity required). This is a hard constraint that limits cluster flexibility.

---

### 2.11 AWS Lambda / SOCI Lazy Pull

**Sources:** [ATC '23 paper: On-demand Container Loading in AWS Lambda](https://www.usenix.org/system/files/atc23-brooker.pdf), [SOCI snapshotter](https://github.com/awslabs/soci-snapshotter), [AWS Fargate SOCI blog](https://aws.amazon.com/blogs/containers/under-the-hood-lazy-loading-container-images-with-seekable-oci-and-aws-fargate/)

#### AWS Lambda container loading (block-level)
Lambda converts OCI image layers (OverlayFS tarballs) into a **single flat block device image** at function creation time. At invocation:
1. Block device image mounted (read-only, shared across all concurrent invocations of the same function)
2. Per-invocation writable layer mounted on top (OverlayFS or similar)
3. **No image download at invocation time** — all image data is already on the worker node or served via FUSE+network on demand

Key innovation: blocks are **content-addressed at the block level**, not the file level. Chunks shared between different Lambda functions' images are fetched once and cached.

#### SOCI Snapshotter (open source version)
SOCI (Seekable OCI) adds a **Table of Contents** index alongside a standard OCI image. The index allows:
- Jumping into the middle of a layer tarball to extract a specific file
- Lazy pull: start container before full image download
- No image conversion required (unlike Stargz/eStargz)

SOCI is used by AWS Fargate for sub-second container starts without requiring image pre-pull.

---

## 3. Techniques Reference Table

| Technique | What's Baked | What's Applied at Boot | Combinatorial Explosion Risk | Sub-10s Boot? | Notes |
|-----------|-------------|----------------------|------------------------------|---------------|-------|
| **Firecracker full snapshot** | Full VM memory + device state | Network re-setup, env vars injected via guest agent | Low (one snapshot per base config) | ✅ < 200 ms | CoW memory file shared across clones |
| **Firecracker diff snapshot** | Only dirty pages since base | Applied on top of base (rebase required) | Medium (chain of diffs) | ✅ | Still developer preview |
| **CRIU (runc)** | Full process tree + memory | FD re-open, network re-establish | Low (one checkpoint per base) | ✅ ~100 ms | Fails with open TCP; GPU not saved |
| **gVisor checkpoint** | Full process tree via gVisor kernel | Network reconnect, GPU re-init | Low | ✅ 0.69–1.05 s (Modal) | GPU state excluded; auto fallback on fail |
| **gVisor fs snapshot** | Filesystem mutations only (no process state) | Full cold boot but with pre-installed packages | Low | ✅ (0.5 s with optimized init) | Separate from process checkpoint |
| **OverlayFS lower layers** | Read-only image layers (shared in page cache) | Per-container upperdir (empty CoW layer) | None (layers shared by content hash) | ✅ instant mount | 100s of containers share same pages |
| **E2B templates** | Firecracker VM snapshot (memory + disk) | Env vars, file uploads, agent commands | Low (one template per Dockerfile) | ✅ ~150 ms | Per-user config applied post-resume |
| **Modal memory snapshots** | gVisor process tree up to pre-request state | GPU init (post-restore hook), request routing | Low-medium (per CPU arch) | ✅ < 1 s p50 | Python imports skipped on restore |
| **Kata EROFS layers** | Read-only container image layers in EROFS | Per-pod writable ext4 upper | None (shared EROFS in page cache) | ✅ ~100–500 ms | VM boot overhead; Nydus for lazy pull inside guest |
| **Gitpod VolumeSnapshot prebuilds** | `init` task results in a PVC snapshot | CoW clone of PVC, user identity, `command` tasks | Low (per branch/template) | ✅ (clone is instant) | Node-local if using TopoLVM |
| **Coder prebuilt workspaces** | Fully provisioned running workspace instance | Re-assignment of owner, dotfiles injection | Low (per preset × instance count) | ✅ (already running) | Terraform-driven; preset-keyed |
| **Nix store bind-mount** | `/nix/store` content-addressed packages | User's profile symlink tree | None (packages deduplicated by hash) | ✅ instant | Must pre-build or cache packages |
| **LVM thin snapshot (TopoLVM)** | Pre-built workspace volume state | CoW clone (metadata-only, instant) | None (storage grows with writes only) | ✅ instant clone | Node-local constraint; Kubernetes scheduling impact |
| **SOCI/lazy pull** | Block-level content-addressed image index | On-demand block fetch from cache/network | None (blocks shared across functions) | ✅ | No conversion step needed |
| **UFFD lazy page serve** | Snapshot stored remotely | Pages fetched on first fault from FUSE/network | None (pages shared read-only) | ✅ (start before fully loaded) | Tail latency risk on cold cache |

---

## 4. Key Questions Answered

### Q1: What do platforms bake INTO a snapshot vs. apply as a fast overlay AT boot?

**Baked into snapshot (expensive, stable, shared):**
- OS kernel boot sequence (fully completed)
- Package manager installs: `apt install`, `pip install`, `npm install -g`
- Language runtime initialization (Python interpreter, JVM class loading, V8 warmup)
- Application framework initialization (Django `setup()`, Spring context)
- Build artifacts (`cargo build`, `make`, compiled assets)
- CA certificates, system configuration files
- Slow systemd unit completion (NTP sync, etc.)

**Applied as overlay at boot (cheap, per-instance, variable):**
- Environment variables (`DATABASE_URL`, `API_KEY`, user identity tokens)
- User-specific files (dotfiles, SSH keys, project code via git clone or bind-mount)
- Network addresses (always re-established post-resume)
- Per-sandbox filesystem upper layer (empty OverlayFS upperdir, ~0 cost)
- Post-resume hooks (GPU VRAM load, NTP clock sync, credential refresh)
- Runtime `sudo` commands inside a running sandbox (E2B model)

### Q2: How do platforms decide snapshot granularity/key to serve many configs?

The universal answer is **"key by the stable, expensive part; leave the variable part out"**:

1. **Image content hash** (Docker/OCI): snapshot key = SHA256 of each layer's tarball. Two images that share layers share the snapshot data in page cache.

2. **Template definition hash** (E2B, Coder): snapshot key = hash of `e2b.Dockerfile` or Terraform template definition. Config variance below the template level (env vars, user identity) is NOT part of the key.

3. **Git branch/commit** (Gitpod): prebuild key = repo URL + branch + `.gitpod.yml` hash. Users on the same branch share a snapshot.

4. **CPU architecture + runtime version** (Modal): snapshot key = (function code hash, container image hash, CPU feature set, NVIDIA driver version). Modal creates one snapshot per compatible host type, not per user.

5. **Nix derivation hash**: package key = hash of all inputs (source + deps + build env). Packages with identical inputs → same `/nix/store/<hash>` path → shared pages regardless of which sandbox requests them.

**Anti-pattern:** keying snapshots on user ID, session ID, or runtime config values → O(users × configs) snapshots.

### Q3: How is 'system-level install' (apt/npm -g) handled without a per-user rebuild?

Three patterns, in order of flexibility:

**Pattern A: Bake-and-snapshot (E2B, Modal, Gitpod init tasks)**
- System packages are installed during template build
- Entire state snapshotted after install
- New installs by users → run at sandbox startup (not baked)
- Fast for the common case; slow for users installing unusual packages

**Pattern B: Shared read-only store (Nix)**
- Packages installed to content-addressed paths in `/nix/store`
- Store bind-mounted read-only into every sandbox
- Per-user "installs" are symlink operations in `~/.nix-profile` — instant, no actual copy
- New packages built once, available to all sandboxes immediately after build
- Works even with per-user package sets: `nix develop` materializes a shell from a declarative spec

**Pattern C: Shared volume with overlay (custom)**
- A base LVM thin volume or NFS share contains pre-installed tools
- Each sandbox gets a CoW thin snapshot for writes
- System-level installs in a sandbox write to that sandbox's CoW layer only
- If a user installs a package that should be shared, it must be promoted to the base (requires operator action)

**Pattern D: Layered OCI images (Docker, Kata)**
- System installs are committed as new image layers
- All containers using the same image layer share it in page cache
- Per-user installs at runtime go to the per-container upperdir (lost on stop unless committed)

### Q4: Techniques to avoid combinatorial snapshot explosion

| Technique | How It Prevents Explosion |
|-----------|--------------------------|
| **Content-addressed layers** | Two configs with the same packages → same layer hash → same snapshot |
| **OverlayFS layer sharing** | N containers share M read-only layers; only N small upper layers needed |
| **Base + overlay model** | One base snapshot; per-user diffs are thin (CoW) on top |
| **Environment injection** | Config variance expressed as env vars, not baked state |
| **Bind-mount for user content** | User files mounted in, not baked → base unchanged |
| **Lazy pull / UFFD** | Don't need full snapshot on every host; fetch pages as needed |
| **Nix content-addressing** | Package dedup at the store level; no redundant copies |
| **Preset-keyed prebuilds (Coder)** | Prebuild per named preset, not per user |
| **Branch-keyed prebuilds (Gitpod)** | Prebuild per branch, not per developer |
| **Post-restore hooks for GPU** | GPU state excluded from snapshot; re-init after restore → one snapshot serves all |

---

## 5. Recommended Model

### "One Base Snapshot + Cheap Per-Config Overlay at Boot"

```
┌────────────────────────────────────────────────────────┐
│  BASE SNAPSHOT  (one per language/runtime version)     │
│  ─────────────────────────────────────────────────     │
│  • OS + kernel boot completed                          │
│  • Language runtime (Python 3.11, Node 20, etc.)       │
│  • System packages (apt, pip, npm -g) baked in         │
│  • Application framework initialized                   │
│  • Firecracker mem_file (immutable, MAP_PRIVATE shared)│
│  • OverlayFS lowerdir layers (shared in page cache)    │
└────────────────────────────┬───────────────────────────┘
                             │ resume (< 200 ms)
                             ▼
┌────────────────────────────────────────────────────────┐
│  PER-SANDBOX OVERLAY  (applied at resume, ~0–500 ms)   │
│  ─────────────────────────────────────────────────     │
│  • OverlayFS upperdir (empty CoW, instant)             │
│  • Environment variables injected via guest agent      │
│  • User identity / credentials (env or bind-mount)     │
│  • Project files (bind-mount from host or lazy clone)  │
│  • Network re-setup (new TAP, new IP)                  │
│  • Post-resume hooks (clock sync, GPU init, token      │
│    rotation, PRNG re-seed)                             │
└────────────────────────────────────────────────────────┘
```

**Implementation stack recommendation:**

1. **VM layer:** Firecracker with `MAP_PRIVATE` + UFFD page serving (start VM before full mem load)
2. **Filesystem layer:** OverlayFS with EROFS or ext4 lower layers (shared read-only); per-sandbox thin LVM upper
3. **Memory snapshot granularity:** Key = (base image hash, runtime version, init-complete marker); do NOT include user ID or runtime config in key
4. **System packages:** Bake into base snapshot via template build pipeline; use Nix for packages that vary per-team but are shared across users
5. **User config delivery:** Guest agent reads from metadata service at resume; injects into env, writes user files
6. **Post-resume init:** Keep to < 500 ms; acceptable: git clone (shallow), credential fetch, clock sync; NOT acceptable: npm install, apt install

---

## 6. Config Classes That CANNOT Be an Overlay and Must Be Baked

These classes of config **fundamentally cannot** be applied as a post-resume overlay without incurring significant latency or requiring a snapshot rebuild:

| Config Class | Why Can't Be Overlay | Required Approach |
|-------------|---------------------|-------------------|
| **Kernel version / kernel modules** | The running kernel IS the snapshot; changing it requires a cold boot | Bake into base; maintain separate snapshots per kernel |
| **System-level shared libraries (.so) required at process init** | Already mapped into memory at snapshot time; can't swap out post-resume without process restart | Bake into base image |
| **Init system / systemd unit set** | Service topology baked at boot; adding/removing units post-resume requires systemctl which may fail | Bake; use systemd unit masking to control what's enabled |
| **Language runtime version** (CPython 3.10 vs 3.11) | Interpreter binary is mapped at process start; bytecode compiled for specific version | Separate base snapshot per runtime version |
| **GPU driver version** | gVisor/NVIDIA GPU state is not snapshotted; driver ABI baked into host; snapshot must match | One snapshot per driver version; Modal does this automatically |
| **Trusted CA certificates affecting SSL at import time** | Some libraries (requests, urllib3) read CA bundle at import; bundle baked into process memory | Bake into base; or use gVisor fs snapshot to capture post-cert-install state |
| **Large global package installs that affect module path at import** | Python's `sys.path` is set at interpreter start and captured in process snapshot | Bake into base template |
| **Network namespaces / firewall rules** | Network state not preserved across snapshot restore; must be rebuilt | Always post-resume (this is fine — it's fast with veth/TAP setup) |

**Safe as overlay (can always be applied post-resume):**
- Any environment variable
- Any file written to the container's upperdir
- User identity / credentials
- Project source code
- Runtime configuration files read lazily by the application (not at import time)
- Any state communicated to the application via its API (e.g., passing `user_id` in the first request)

---

## 7. References

1. **Firecracker snapshot documentation** — `docs/snapshotting/snapshot-support.md` in [firecracker-microvm/firecracker](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)

2. **Firecracker UFFD page fault handling** — `docs/snapshotting/handling-page-faults-on-snapshot-resume.md` in [firecracker-microvm/firecracker](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/handling-page-faults-on-snapshot-resume.md)

3. **Modal memory snapshots blog post** — "Memory snapshots: Checkpoint/restore for sub-second startup", Modal Engineering, Jan 2025. [modal.com/blog/mem-snapshots](https://modal.com/blog/mem-snapshots)

4. **Modal GPU memory snapshots** — "GPU Memory Snapshots: Supercharging sub-second startup", Modal. [modal.com/blog/gpu-mem-snapshots](https://modal.com/blog/gpu-mem-snapshots)

5. **E2B template how-it-works** — [e2b.dev/docs/template/how-it-works](https://e2b.dev/docs/template/how-it-works)

6. **E2B cold boot optimization PR** — "Speed up guest cold boot (#3020)" [github.com/e2b-dev/infra/commit/f05ccea](https://github.com/e2b-dev/infra/commit/f05ccea7aab62252948173a71a83f19c12f919b5)

7. **E2B snapshots vs templates** — [github.com/e2b-dev/docs/commit/25ebcf4](https://github.com/e2b-dev/docs/commit/25ebcf4aa9fcc072bd11bf88383d3fd4151cd3d2)

8. **gVisor Checkpoint/Restore** — [gvisor.dev/docs/user_guide/checkpoint_restore](https://gvisor.dev/docs/user_guide/checkpoint_restore/)

9. **gVisor Filesystem Snapshots** — [gvisor.dev/docs/user_guide/fs_snapshot](https://gvisor.dev/docs/user_guide/fs_snapshot/)

10. **gVisor application-driven checkpoint PR #13537** — [github.com/google/gvisor/pull/13537](https://github.com/google/gvisor/pull/13537)

11. **CRIU overview** — [criu.org/Checkpoint/Restore](https://criu.org/Checkpoint/Restore)

12. **CRIU + Docker + OverlayFS (LPC 2020)** — "Checkpoint-restoring containers with Docker inside", Linux Plumbers Conference 2020. [lpc.events PDF](https://lpc.events/event/7/contributions/643/attachments/540/958/LPC_2020_Docker_CRIU.pdf)

13. **CRIU lazy pages (UFFD)** — [criu.org/Userfaultfd](https://criu.org/Userfaultfd)

14. **Kata Containers architecture** — [github.com/kata-containers/kata-containers/blob/main/docs/design/architecture.md](https://github.com/kata-containers/kata-containers/blob/main/docs/design/architecture.md)

15. **Kata EROFS snapshotter** — [github.com/kata-containers/kata-containers/.../how-to-use-erofs-snapshotter-with-kata.md](https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-use-erofs-snapshotter-with-kata.md)

16. **Kata per-sandbox config annotations** — [github.com/kata-containers/.../how-to-set-sandbox-config-kata.md](https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-set-sandbox-config-kata.md)

17. **Linux OverlayFS documentation** — [docs.kernel.org/filesystems/overlayfs.html](https://docs.kernel.org/filesystems/overlayfs.html)

18. **Docker OverlayFS storage driver** — [docs.docker.com/engine/storage/drivers/overlayfs-driver](https://docs.docker.com/engine/storage/drivers/overlayfs-driver/)

19. **Gitpod PVC prebuilds (PR #10689)** — [github.com/gitpod-io/gitpod/pull/10689](https://github.com/gitpod-io/gitpod/pull/10689)

20. **Coder prebuilt workspaces** — [coder.com/docs/admin/templates/extending-templates/prebuilt-workspaces](https://coder.com/docs/admin/templates/extending-templates/prebuilt-workspaces)

21. **Coder instant infrastructure blog (2025)** — [coder.com/blog/launch-week-2025-instant-infrastructure](https://coder.com/blog/launch-week-2025-instant-infrastructure)

22. **Nix content-addressed store** — [releases.nixos.org/nix/nix-2.34.0/manual/store/store-object/content-address.html](https://releases.nixos.org/nix/nix-2.34.0/manual/store/store-object/content-address.html)

23. **NixOS wiki** — [wiki.nixos.org/wiki/Nix_(package_manager)/en](https://wiki.nixos.org/wiki/Nix_%28package_manager%29/en)

24. **TopoLVM thin volumes** — [github.com/topolvm/topolvm/blob/main/docs/proposals/thin-volumes.md](https://github.com/topolvm/topolvm/blob/main/docs/proposals/thin-volumes.md)

25. **TopoLVM thin snapshot PR #738** — [github.com/topolvm/topolvm/pull/738](https://github.com/topolvm/topolvm/pull/738)

26. **AWS Lambda on-demand container loading (ATC '23)** — Brooker et al., USENIX ATC 2023. [usenix.org/system/files/atc23-brooker.pdf](https://www.usenix.org/system/files/atc23-brooker.pdf)

27. **SOCI snapshotter (Seekable OCI)** — [github.com/awslabs/soci-snapshotter](https://github.com/awslabs/soci-snapshotter)

28. **AWS Fargate SOCI lazy loading** — [aws.amazon.com/blogs/containers/under-the-hood-lazy-loading-container-images-with-seekable-oci-and-aws-fargate](https://aws.amazon.com/blogs/containers/under-the-hood-lazy-loading-container-images-with-seekable-oci-and-aws-fargate/)

29. **Sabre: Hardware-Accelerated Snapshot Compression for Serverless MicroVMs** — OSDI 2024. [csl.cornell.edu/~zhiruz/pdfs/sabre-osdi2024.pdf](https://www.csl.cornell.edu/~zhiruz/pdfs/sabre-osdi2024.pdf)

30. **TrEnv: Transparently Share Serverless Execution Environments** — SOSP 2024. [madsys.cs.tsinghua.edu.cn/publication/trenv](https://madsys.cs.tsinghua.edu.cn/publication/trenv-transparently-share-serverless-execution-environments-across-different-functions-and-nodes/SOSP24-huang.pdf)

31. **Cloud Hypervisor UFFD demand-paged snapshot restore** — PR #7800. [github.com/cloud-hypervisor/cloud-hypervisor/pull/7800](https://github.com/cloud-hypervisor/cloud-hypervisor/pull/7800)
