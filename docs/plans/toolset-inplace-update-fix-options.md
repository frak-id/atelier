# Fixing in-place toolset updates — the two chosen options (A′ + C)

Follow-up to [`toolset-inplace-update-overlay-enoent.md`](./toolset-inplace-update-overlay-enoent.md).
That doc diagnosed the failure; this one records the two fixes we're
committing to after an oracle (fable-5, xhigh) review:

- **A′ — virtiofsd `--xattrmap`** — the near-term, smallest-diff root-cause
  fix. Drop `userxattr`, regain `redirect_dir=on`, so npm's atomic in-place
  replace works on the first `pi update`. (**A″** — `modcaps=+sys_admin` — is a
  simpler, more-privileged variant; see §2.) **Both are spike-gated: they only
  work if the bug is the `trusted.*`/`redirect_dir` gap and not virtio-fs
  caching — see the §1 diagnosis box.**
- **C — virtio-blk PVC** — the long-term architecture. Stop putting `/data`
  behind virtio-fs; attach the PVC as a block device and let the guest format
  it natively. Removes the whole xattr bug class (and likely a big home-I/O
  perf win) — but it's a project, not a patch. §3b generalizes C into a
  **backend-neutral contract** so the fix holds on Docker, managed k8s
  (GKE/EKS), and locked-down/rootless hosts too — not just Kata.

The loop-backed-ext4-upper idea (originally "Option A") is **dropped**: it's
viable but strictly more moving parts than A′ for the same outcome (loop
device, `e2fsck`, image sizing, online-grow, `fstrim`/discard, a one-time
copy-in migration, and a new "unmountable image = home bricked" incident
class). A′ gets the same result via one host-side config flag. Keep loop-ext4
only as a fallback if the A′ spike fails.

---

## 0. The constraints any fix must satisfy

1. **Zero-copy boot** — toolsets stay overlay lowerdirs, NO per-boot copy.
   (Copy-in-at-boot was tried; npm-heavy tools = thousands of small files =
   5+ s boot lag. Rejected.)
2. **In-place update works** — `pi update` (`npm install -g --prefix ~/.local`,
   which renames the old package dir then `mkdir`s a fresh one) must succeed
   in a live sandbox, first try.
3. **Durable + capturable** — updated bytes land in the writable layer and
   `capture()` reads the merged `/home/dev` view. (Already true today.)
4. **Survives crash-consistent PVC snapshot** — pause is a best-effort guest
   `sync` then a live VolumeSnapshot of the whole PVC (no fsfreeze / no clean
   unmount).

Also rejected: blocking/no-op'ing in-sandbox `pi update` — it defeats the
core "update in sandbox → recapture" product loop (devs layer custom config
on top of a base toolset; a clean rebuild would lose it).

## 1. Root cause (recap)

`/home/dev` is a single kernel overlay:

```
mount -t overlay overlay /home/dev \
  -o lowerdir=<toolsetN>:…:<toolset1>:/home/skel,\
     upperdir=/data/upper,workdir=/data/work,userxattr
```

`/data` is the PVC exposed to the guest via **Kata virtio-fs**, which forwards
only the `user.*` xattr namespace. Kernel overlayfs normally stores its
metadata in `trusted.overlay.*`; on virtio-fs that hard-fails ("upper fs
missing required features"), so the guest mounts with **`userxattr`**
(overlay uses `user.overlay.*` instead). But `userxattr` **forces
`redirect_dir=nofollow` and `metacopy=off`** — and without `redirect_dir`,
renaming a lower-origin directory across the lower→upper boundary isn't
supported. npm's rename-then-`mkdir` therefore fails on the **first** in-place
replacement of a toolset-provided (lower-only) directory tree.

The constraint is **upper-only**: `redirect_dir` writes its xattr on *upper*
directories; the RO erofs/squashfs lowers are only ever read. Fixing the
upper's xattr semantics fixes the bug.

> **⚠ Diagnosis is inferred, not proven — and the evidence points partly away
> from redirect_dir.** The *documented* overlayfs behavior for renaming a
> lower-only directory without `redirect_dir` is **EXDEV** (userspace is
> expected to copy-fallback), **not** the observed **ENOENT** on the following
> `mkdir` (kernel.org overlayfs docs, "Renaming directories"). The closest
> real-world precedent — [virtio-fs/qemu#21](https://gitlab.com/virtio-fs/qemu/-/issues/21),
> *npm install on overlayfs-on-virtio-fs under Kata* — fails with **ESTALE**
> caused by **virtio-fs `cache=auto` dentry/attr caching racing overlayfs
> copy_up**, and it reproduced even with `trusted.*` xattrs fully working
> (`modcaps=+sys_admin`). So our ENOENT may be the **same virtio-fs
> caching class**, not a redirect_dir problem at all.
>
> **Consequence for the plan:** if the root cause is virtio-fs caching, then
> **A′/A″ (which keep virtio-fs) may not fix it — only C (which removes
> virtio-fs) is guaranteed.** This is why the spike (§4) is load-bearing, and
> why it must also vary the **virtio-fs cache mode** (our config inherits the
> stock clh default, `kata-atelier-values.yaml:32`), not just the xattr mode.
> A′ is a *cheap gamble worth trying first*; C is the *safe bet* it falls back
> to.

---

## 2. Option A′ — virtiofsd `--xattrmap` (near-term fix)

### Idea

Have virtiofsd on the host **remap** the guest's `trusted.overlay.*` xattrs to
a host-side `user.*` prefix. The host still stores them as unprivileged
`user.*` (no host privilege needed), but the *guest* sees a working
`trusted.overlay.*` namespace — so the guest can mount the overlay **without
`userxattr`**, with `redirect_dir=on`, and npm's atomic rename works.

This is the **upstream-designed** solution for "kernel overlayfs upper on
virtio-fs": the root problem is that plain `trusted.*` pass-through needs the
host-side virtiofsd to hold `CAP_SYS_ADMIN`, and `--xattrmap` was added
precisely so a sandboxed/unprivileged virtiofsd can still back a kernel
overlay upperdir (Red Hat BZ 1860491, fixed in qemu-kvm-5.2.0;
`virtiofsd/doc/xattr-mapping.md` example 2 is literally the `trusted.*` →
`user.*` remap). We already run a chart-managed custom runtime with
`virtio_fs_extra_args`, so this is a drop-in config change plus one mount-flag
change — **zero new data-path components, zero boot cost, crash-consistency
byte-identical to today**.

> **Caveat (see §1's diagnosis box):** A′ only fixes the failure if its root
> cause is the missing `trusted.overlay.*`/`redirect_dir` support. If the
> ENOENT is actually virtio-fs cache-coherence (the ESTALE class in
> virtio-fs/qemu#21), A′ keeps virtio-fs and may not help — spike first (§4).

### Patch 1 — host: virtiofsd xattrmap

`infra/k8s/v2/kata-atelier-values.yaml` — extend the `atelier-clh` drop-in.
Replace the `--xattr` line with `--xattr` + an `--xattrmap` that (a) maps the
overlay's `trusted.overlay.` prefix to a host `user.ovl-trusted.overlay.`
prefix in both directions, and (b) **denies** the guest direct `user.*`
access to that host prefix (so the dev user can't forge overlay metadata):

```toml
[hypervisor.clh]
# Kata config.d drop-ins REPLACE arrays (no append), so restate the stock
# args. --xattr enables xattr forwarding; --xattrmap gives the guest a working
# trusted.overlay.* namespace backed by host user.* (no host privilege), so
# the guest overlay can drop `userxattr` and use redirect_dir=on.
# Rule form is :type:scope:key:prepend: ; first match wins; the set MUST end
# in a catch-all or unmatched xattr access fails.
virtio_fs_extra_args = [
  "--thread-pool-size=1",
  "--announce-submounts",
  "--xattr",
  "--xattrmap=:prefix:all:trusted.overlay.:user.ovl-trusted.overlay.::bad:server::trusted.overlay.::bad:client:user.ovl-trusted.overlay.:::ok:client:user.:::ok:server::security.::ok:all:::",
]
```

Rule semantics (validated against `virtiofsd/doc/xattr-mapping.md`; rule form
`:type:scope:key:prepend:`, first match wins):

1. `:prefix:all:trusted.overlay.:user.ovl-trusted.overlay.:` — remap guest
   `trusted.overlay.*` ⇄ host `user.ovl-trusted.overlay.*` in **both**
   directions (client set/get + server listxattr).
2. `:bad:server::trusted.overlay.:` — hide any real host `trusted.overlay.*`
   from the guest's listxattr (so only the mapped view exists).
3. `:bad:client:user.ovl-trusted.overlay.::` — **deny** the guest direct
   access to the mapped `user.*` prefix (blocks forging overlay metadata —
   the doc explicitly requires this guard when selectively remapping).
4. `:ok:client:user.::` / `:ok:server::security.:` — pass ordinary `user.*`
   and `security.*` through unchanged.
5. `:ok:all:::` — mandatory catch-all.

> Verify the exact rule string against the **shipped** virtiofsd's `--xattrmap`
> grammar before applying (§4) — the serialization is fiddly and the binary
> version matters.

### Patch 2 — guest: drop `userxattr`, add `redirect_dir=on`

`apps/agent-v2/src/toolset.rs`, the overlay assembly in `materialize_inner`
(~`toolset.rs:1080-1092`). Change the mount option tail:

```diff
- mount -t overlay overlay {home} \
-   -o lowerdir={lowerdir},upperdir={upper},workdir={work},userxattr
+ mount -t overlay overlay {home} \
+   -o lowerdir={lowerdir},upperdir={upper},workdir={work},redirect_dir=on,index=off,metacopy=off
```

Notes:
- **Pass `redirect_dir=on` explicitly.** Without `userxattr`, the default
  depends on the guest kernel's `CONFIG_OVERLAY_FS_REDIRECT_DIR`; don't rely
  on it.
- **Keep `index=off` and `metacopy=off`.** We only need `redirect_dir` to fix
  npm. `metacopy` would drag in copied-up-symlink `origin`-xattr code paths
  (`user.*` can't be set on symlinks/device nodes on the host); `index=on`
  wants file-handle export, which our squashfs lowers are built without
  (`-no-exports`, `toolset.rs:129`) — see §5.
- `self_heal_home` (`toolset.rs:1225`) re-drives `materialize`, so it inherits
  the new mount options for free. Update the matched-pair comment in
  `kata-atelier-values.yaml` (it currently says "Matched pair with the agent's
  `userxattr` mount option — remove both together").

### Migration (must not be skipped)

Existing live/paused sandboxes have uppers written under `userxattr`, carrying
`user.overlay.opaque` markers (dirs deleted-then-recreated over a lower). In
trusted mode those markers become invisible → previously-deleted lower files
could **reappear** in the merged view. (Whiteouts are device nodes — format
is shared across modes, unaffected.)

Two acceptable strategies:

1. **Per-sandbox mode flag (preferred, simplest).** Record the overlay xattr
   mode in the persisted materialize request (`.materialize.json`,
   `MATERIALIZE_REQUEST_PATH`, `toolset.rs:60`). Sandboxes created before the
   rollout keep `userxattr`; only newly-created sandboxes use the trusted
   `redirect_dir=on` mode. Old sandboxes migrate by natural churn (destroy +
   recreate). No in-place rewrite.
2. **One-time xattr-rewrite walk.** At first materialize under the new mode,
   walk `/data/upper` and translate `user.overlay.*` markers to their
   `trusted.overlay.*` equivalents. Bounded, but riskier — only if we must
   convert existing sandboxes in place.

Go with (1) unless product needs existing sandboxes converted without a
recreate.

### A″ — the even-simpler alternative: `modcaps=+sys_admin` (no rule string)

The `trusted.*` problem exists only because the **host-side virtiofsd lacks
`CAP_SYS_ADMIN`**. Instead of remapping with `--xattrmap`, you can just grant
it the cap: add `modcaps=+sys_admin` to `virtio_fs_extra_args` and drop
`userxattr` on the guest mount (same Patch 2). Then plain `trusted.overlay.*`
pass-through works — **no fiddly xattrmap rule string, no anti-forge guard to
get right.**

Tradeoff: it **elevates virtiofsd's host privilege** (a per-sandbox daemon now
runs with `CAP_SYS_ADMIN` on the node), whereas `--xattrmap` keeps virtiofsd
unprivileged and stores everything as `user.*`. Both are documented, valid,
and in the field (virtio-fs/qemu#21 used `modcaps=+sys_admin`). Prefer
`--xattrmap` for the better host posture; keep `modcaps=+sys_admin` as the
**cheapest thing to try in the spike** (one arg, no rule grammar) to isolate
whether the failure is xattr/`redirect_dir` at all vs. a caching-class bug
(§1 diagnosis box) — if `modcaps=+sys_admin` + drop-`userxattr` *still* fails,
the cause is virtio-fs caching and only C fixes it.

### Why A′ beats loop-ext4 (dropped "Option A")

| | A′ (xattrmap) | loop-ext4 upper |
|---|---|---|
| New data-path components | none | loop device + ext4-in-a-file |
| Boot cost | zero | one loop mount (+ fsck) |
| Crash-consistency | identical to today | dirty-journal replay; worst case unmountable image = home bricked |
| ENOSPC behaviour | unchanged (PVC grows) | sparse-image-over-full-PVC → journal abort → `/home/dev` RO mid-session |
| New machinery owned forever | one config flag | image sizing, online-grow, `fstrim`/discard, `e2fsck` path |
| Migration | mode flag (or xattr walk) | one-time copy of raw upper into the image (a copy-in — the thing we rejected) |
| Security | **better** (can't forge overlay metadata) | unchanged |

### A′ residual risks

- **Diagnosis may be caching, not xattr** — if so, A′/A″ don't fix it; C does.
  Spike first, varying cache mode (§1 box, §4).
- **virtiofsd version** — the shipped binary (kata-deploy 3.31) must support
  `--xattrmap`; verify (§4).
- **Opaque-marker migration** — do not skip it.

---

## 3. Option C — virtio-blk PVC (long-term architecture)

### Idea

The PVC is a TopoLVM logical volume — a **block device**. Virtio-fs is the
wrong transport for a single-writer private disk: it's the *reason* for the
xattr problem, and it's slow for exactly the many-small-files npm workloads we
care about. Attach the PVC to the guest as **virtio-blk** (`volumeMode:
Block`, Kata block-device hotplug — CLH supports it) and let the guest
format/mount ext4 (or xfs) **natively**.

Result:
- Full `trusted.*` xattrs; `redirect_dir` / `index` / `metacopy` all real —
  the entire bug class evaporates, no remap, no loop.
- **Cleaner** crash-consistency: the guest fs journal sits directly above the
  snapshotted block device — no host-page-cache ambiguity between the guest
  `sync` and the LVM snapshot.
- Likely a large perf win for home I/O generally.

### Sketch of the work

- **`kube.resources.ts`** — the PVC currently mounts as a filesystem at
  `VM.DATA` (`kube.resources.ts:80-91`). Switch to a block claim: PVC
  `spec.volumeMode: Block` (`buildPvc`, ~`kube.resources.ts:296`), and the pod
  uses `volumeDevices` (with a `devicePath`, e.g. `/dev/atelier-data`) instead
  of `volumeMounts` for the workspace volume.
- **Guest agent** — on first boot, `mkfs.ext4` the raw device (idempotent:
  probe for an existing fs first, like `detect_build_format` probes
  `/proc/filesystems`), then mount it at `/data`; the overlay assembly above
  it is unchanged **except** it can now use plain `trusted.overlay.*`
  (no `userxattr`, no xattrmap).
- **Pause / resume** — the hard part. Old pause snapshots contain a **host-fs
  directory tree** (`/data/...` as virtio-fs); new ones contain a **guest
  filesystem image** on a block device. Resume must handle both:
  dual-mode resume (detect snapshot generation and mount accordingly) or a
  one-shot migration that reformats+copies old sandboxes forward. VolumeSnapshot
  of a block PVC is still a block snapshot — but its *contents* are now a
  guest-formatted fs, so the runtime's snapshot/clone bookkeeping
  (`snapshotPvc`, resume source resolution) is semantically unchanged while
  the *materialize* side changes.
- **Kata runtime config** — block hotplug for the `atelier-clh` class; verify
  CLH block-device support in the shipped kata-deploy.

### Two points in C's favor (verified against the codebase)

- **File injection is already guest-side.** `files`/`env` are pushed via the
  agent (`agent.writeFiles` — `runtime.service.ts:426,850`, `boot-agent.ts:42`),
  not by a host-side write into the PVC directory. So a block-mode,
  guest-formatted (opaque-to-host) `/data` does **not** break file push, and
  prebuild cloning is already block-level (`snapshotPvc` + PVC `dataSource`).
- **We already run `topolvm-thin`** (`30-config.yaml:51`, `values.production.yaml:67`),
  which satisfies TopoLVM's constraint that **snapshots exist only for thin
  volumes** — so block-mode PVCs + VolumeSnapshots are available on our storage
  class today (node-locality of restore is unchanged from now).

### Known limitations (Kata Direct-Assigned Volume — research-flagged)

Block-mode PVCs into a Kata guest go through Kata's **Direct-Assigned Volume**
(DAV) mechanism. It's real and actively developed (2024–2025) but **not as
mature as virtio-fs directory sharing** — price these in before committing:

- **virtio-blk only under Cloud Hypervisor** (clh's `hotplugAddBlockDevice`
  rejects virtio-scsi). Fine for us, but no fallback driver.
- **`ReadWriteOncePod` only** — DAV assumes one pod per block device; sharing
  is explicitly unsafe. **No `subPath`, no `fsGroup`, no `fsGroupChangePolicy`.**
- **Open upstream bugs**: init-container → app-container hot-replug staling the
  fs ([kata #12689]), and udev-uevent device-detection timeouts for the
  `virtio-blk-pci` regex causing create failures ([kata #11238]).
- **TopoLVM + Kata-DAV + block-snapshot is an unproven 3-way combo** — each
  piece works independently; no end-to-end reference. **PoC before committing.**

[kata #12689]: https://github.com/kata-containers/kata-containers/issues/12689
[kata #11238]: https://github.com/kata-containers/kata-containers/issues/11238

### Why it's a project, not a patch

It touches the storage contract end-to-end (pod spec, agent boot, mkfs
lifecycle, the DAV maturity gaps above, and — the real cost — snapshot/resume
compatibility across a format change). Plan and schedule it independently;
**do not block the near-term fix (A′) on it.** A′ and C are compatible: A′
keeps virtio-fs and un-breaks npm now; C later removes virtio-fs from `/data`
entirely and makes the xattrmap + `userxattr` machinery obsolete (delete both
when C lands). And if the §1 spike shows the bug is virtio-fs **caching**, C
stops being "long-term nice-to-have" and becomes the **only** reliable fix —
pull it forward.

---

## 3b. Portability across backends — the general contract

The whole `userxattr`/`redirect_dir` problem is a **Kata + virtio-fs**
artifact, not a universal one. The writable layer only reaches the disk
through virtio-fs *because* a VM boundary forces it to, and virtio-fs forwards
only `user.*`. Every other hosting backend has a different filesystem model,
and most don't have this problem at all. So the long-term goal is **not**
"virtio-blk everywhere" (that phrase is meaningless off-Kata) — it's a single
contract that each backend satisfies its own way:

> **Contract.** Assemble `/home/dev` = toolset layers (zero-copy where
> possible) + a writable upper **that sits on a filesystem supporting real
> overlay semantics** (`trusted.overlay.*` / working `redirect_dir`), so
> in-place updates (`pi update`) work on first try.

Option C is simply *how Kata reaches this contract* (give the upper a real
block-backed filesystem). A′ is a transitional Kata rung that *fakes* the
contract over virtio-fs. Other backends satisfy it natively.

### What each environment actually is

| Environment | Isolation | What the `/data` upper actually is | In-place overlay update? |
|---|---|---|---|
| **Kata + TopoLVM (prod, today)** | microVM | virtio-fs over an LVM LV → `user.*` only | ❌ (this whole doc) |
| **Kata + virtio-blk (Option C)** | microVM | raw block dev, **guest** formats ext4/xfs natively | ✅ real `trusted.*` |
| **Docker / runc, single host** | container | bind-mount / docker volume on host ext4/xfs/btrfs | ✅ native overlay (needs `CAP_SYS_ADMIN`) |
| **Managed k8s (GKE/EKS), runc nodes** | container | CSI PVC (PD/EBS) in **Filesystem** mode → node formats, presents real ext4 to the pod | ✅ native overlay |
| **Managed k8s + Kata (GKE/EKS)** | microVM | same virtio-fs issue → request `volumeMode: Block` (PD/EBS support it) → virtio-blk | ✅ via C |
| **gVisor (GKE Sandbox)** | userspace kernel | gofer fs, limited xattr/overlay | ⚠️ copy-in floor |
| **macOS** | (Linux VM only) | = the Docker-in-VM case | ✅ inside the VM |

Takeaway: Docker/runc and managed-k8s-runc *can* satisfy the contract with a
real fs on the host/node — but **not "for free" today**: the agent currently
**hardcodes `userxattr`** (`toolset.rs:1086`) on every backend, so the existing
`DockerBackend` (which runs the same agent on an ext4 named volume — see
`docker-volume.backend.ts`) hits the **identical forced `redirect_dir=nofollow`
bug**. The unlock is the capability probe below: once the agent drops
`userxattr` where the upper supports `trusted.overlay.*`, Docker/runc and
managed-k8s-runc get it with **no xattrmap** (their ext4/host fs takes
`trusted.*` natively). **Kata is the one backend that needs extra machinery**
(A′'s xattrmap, or C) — everyone else just needs the hardcode removed.

### The materialization ladder (behind the `SandboxBackend` seam)

This slots into the backend seam and the "mount if you can, copy if you must"
Tar rung already proposed in
[`portable-runtime-backends.md`](../proposals/portable-runtime-backends.md) §7.
It just adds one capability to that probe: *can the upper do in-place overlay
updates?* A `HomeMaterializer` probes the environment and picks the highest
rung that holds:

0. **(Prerequisite) stop hardcoding `userxattr`** (`toolset.rs:1086`). Probe
   the upper: does a `trusted.overlay.*` test-set succeed? This one change is
   what turns rung 1 on for the backends that already have a real fs.
1. **Native overlay, real-fs upper** — Docker/runc, managed-k8s-runc,
   **Kata + virtio-blk (C)**. Zero-copy boot, `trusted.overlay.*`, in-place
   update works. *The target for every first-class backend.*
2. **Overlay + virtio-fs xattr shim (A′ `--xattrmap`, or A″ `modcaps=+sys_admin`)**
   — Kata transitional. Zero-copy, in-place works, keeps virtio-fs. Ship now;
   delete when C lands. *Only helps if the bug is xattr/redirect_dir, not
   virtio-fs caching (§1).*
3. **Copy-into-upper floor** — where no writable overlay is possible (gVisor,
   rootless/locked-down, ancient kernels) **or** where virtio-fs caching
   defeats rung 2. Guaranteed correct, slower boot.

### Two different "copy" fallbacks — don't conflate them

Only one of these solves the *in-place-update* problem:

- **Tar-extract-to-lower** (the `portable-runtime-backends.md` §7 rung): copies
  a toolset into an overlay **lower** dir, for backends that can't loop-mount
  erofs/squashfs. Still read-only layering — it does **not** make in-place
  update work.
- **Copy-into-upper** (rung 3 above): copies the *mutable* toolset into the
  **upper** (pure-upper), so npm's rename never crosses a lower→upper
  boundary. *This* is the "rw-when-mounting-can't" fallback — and it is exactly
  the copy-in-at-boot path we rejected for its 5+ s lag.

Because rung 3 is correct-but-slow **by construction**, it must stay a *floor*,
not the common path: every first-class backend should reach rung 1 or 2 so
nobody actually pays it. Optional optimization even at the floor: copy in only
**mutable** toolsets (the one the dev is iterating on), keep immutable ones as
fast RO lowers — a hybrid that pays the copy only for the tool being updated.

### How this maps to the backend seam work

- The rung selection is a `VolumeBackend`/agent **capability probe**, not
  per-call policy — the runtime keeps passing refs to `materializeToolsets`
  and the agent picks the rung (same split as the §7 Tar rung: "runtime is
  unaffected").
- Rung 1 is also what makes the **`DockerBackend`** self-host path real: a
  container with a host-dir upper gets native overlay `trusted.*` with no
  Kata, no virtio, no xattrmap.
- C and rung 1 are the *same contract*; shipping C is what lets Kata join the
  "native overlay" rung the other backends already sit on, after which the
  Kata-only A′/`userxattr` code deletes cleanly.

---

## 4. The gating spike (do this before building either)

The ENOENT-vs-EXDEV mismatch means the redirect_dir diagnosis is plausible but
unproven. One ~1-day spike de-risks both A′ and C at near-zero cost:

Run the cheapest lever first so a pass/fail cleanly localizes the root cause:

1. **A″ first (one arg).** Add `modcaps=+sys_admin` to `virtio_fs_extra_args`,
   roll the `atelier-clh` runtime. Boot a sandbox, remount `/home/dev`
   **without `userxattr`** (`redirect_dir=on,index=off,metacopy=off`), run a
   **first-touch** `pi update` on a lower-only (never-yet-written) toolset
   package tree.
   - **Pass** ⇒ the bug *was* the `trusted.*`/`redirect_dir` gap. Now decide
     A′ (`--xattrmap`, unprivileged) vs keeping A″ (simpler, privileged
     virtiofsd) for the real fix, and proceed with Patch 2 + the migration
     flag.
   - **Fail** ⇒ trusted xattrs work yet npm still breaks ⇒ **virtio-fs
     caching class** (matches virtio-fs/qemu#21's ESTALE). A′ won't help.
     Go to step 3.
2. If you want to confirm A′ specifically, repeat step 1 with the `--xattrmap`
   drop-in instead of `modcaps` (validates the rule string end-to-end).
3. **Cache-mode + C probe.** Re-run the failing case varying the virtio-fs
   **cache mode** (our config inherits the stock clh default,
   `kata-atelier-values.yaml:32`). If tuning cache mode doesn't fix it,
   that confirms **C (virtio-blk, no virtio-fs)** is the required fix —
   fast-track it (or loop-ext4 as the interim block fs).

Also verify during the spike:
- Guest kernel has `ext4` (for loop-ext4 fallback and for C) —
  `grep ext4 /proc/filesystems` in the guest (this guest notably lacks
  squashfs, so check).
- Shipped virtiofsd supports `--xattrmap` **and** `modcaps` —
  `virtiofsd --help` on the node / in the kata-deploy 3.31 bundle.

---

## 5. Cross-cutting findings (file-pathed)

- **Root cause / where A′ lands**: `apps/agent-v2/src/toolset.rs:1086`
  (`userxattr` → `redirect_dir=on,index=off,metacopy=off`) +
  `infra/k8s/v2/kata-atelier-values.yaml` (`virtio_fs_extra_args` +=
  `--xattrmap`).
- **Keep `index=off`**: squashfs blobs are built `-no-exports`
  (`toolset.rs:129`), which kills file-handle decoding — enabling
  `index=on`/`nfs_export=on`/`verify_lower` later would degrade/fail squashfs
  lowers. Keep `index=off` (or drop `-no-exports` if we ever need index).
- **Keep `metacopy=off`**: avoids copied-up-symlink `origin`-xattr paths that
  `user.*`-on-symlink limits would make load-bearing. (Symlink copy-up itself
  works today — npm renamed `bin/pi` fine; only the *dir* failed.)
- **Migration marker**: existing uppers' `user.overlay.opaque` markers
  (`/data/upper`); gate via the `.materialize.json` mode flag
  (`toolset.rs:60`).
- **Capture unaffected**: `capture()` reads the merged view; redirects and
  whiteouts are transparent to it under every option — no change needed.
- **`self_heal_home`** (`toolset.rs:1225`) and the resume path re-drive
  `materialize`, so they inherit A′'s mount-option change automatically.

## 6. Bottom line

**Spike before you build** (§4): the observed ENOENT may be virtio-fs caching
(the ESTALE class in virtio-fs/qemu#21), not `redirect_dir` — and if so, only
C fixes it. Try the one-arg `modcaps=+sys_admin` lever first to localize the
cause. If it's the xattr gap, ship **A′** (or A″): one host config flag + one
mount-flag change + a per-sandbox migration flag un-breaks `pi update` in
place, at zero boot cost, with unchanged crash-consistency. First real code
step either way: **stop hardcoding `userxattr`** (`toolset.rs:1086`) behind a
capability probe — that alone fixes the non-Kata backends (incl. the existing
Docker backend). Treat the real long-term target as the **§3b contract** — "toolsets as zero-copy layers + a
writable upper on a real (`trusted.*`) filesystem" — selected per backend by a
capability probe behind the `SandboxBackend` seam, floored by copy-into-upper:
Docker/runc and managed-k8s-runc get it for free, and **C (virtio-blk)** is how
Kata joins them (deleting the xattrmap/`userxattr` machinery when it lands).
Keep **B** (lazy per-subtree "thaw") in the back pocket as a days-to-ship
stopgap if users are blocked before A′ lands, and keep **loop-ext4** only as
the A′-spike-fails fallback.
