# Zero-Copy Toolsets — Squashfs Blobs + Overlay Home

**Status:** proposal / design note
**Supersedes:** the "copy-in first" materialization step of
`composed-prebuild-volumes.md` §5 (rung 2). Keeps that document's object
model (repo snapshots + toolset artifacts, source-of-truth is `O(repos +
devs)`); changes only *how* a toolset lands in a booting sandbox.

---

## 1. Problem

Booting a sandbox composes two tiers (`composed-prebuild-volumes.md` §1):

- **Prebuilt / repo** — git workspace + installed deps → a node-local
  `VolumeSnapshot`, **CoW-cloned** at boot. Instant.
- **Toolset** — dev tools (pi/opencode/claude-code + npm deps, skills,
  MCPs, configs) → an OCI artifact in zot, **extracted** at boot.

The extract is the slow path. `materialize()`
(`apps/agent-v2/src/toolset.rs:411-431`) does, per toolset, sequentially:

```
oras pull --plain-http <ref> -o "$tmp"    # gzip tarball → temp dir on PVC
for f in "$tmp"/*.tar.gz: tar -xzf "$f" -C /home/dev   # write every file
```

For npm-shaped trees this writes **thousands of small files into the home
PVC** — inode/metadata/fsync overhead the CoW clone never pays. There is a
**second, unnamed instance of the same disease**: on every fresh boot the
entrypoint restores the image's home skeleton with `cp -a /home/skel/.
/home/dev/` (`infra/images/dev-base/rootfs/etc/sandbox/sandbox-boot.sh:9-12`;
`sandbox-init.sh` Phase 1b does the tarball variant).

Root cause is a **primitive mismatch**: the repo (mutable, per-sandbox) gets
the fast CoW/mount primitive; the toolset (read-mostly, shared, portable)
gets the slow per-file-copy primitive. It is exactly backwards for the
access pattern.

### Goals

1. Make an arbitrary (repo × toolset) boot's toolset cost **independent of
   file count** — a mount, not a copy.
2. **Keep composition N + M forever.** Each toolset stays one artifact; each
   repo stays one snapshot; boot composes them by *mounting*, never by
   materializing a combined artifact.
3. Preserve pause/resume semantics and the click-to-capture-new-version
   flow (`captureToolset`).

### Non-goals (explicitly out of scope)

- **No baked (repo × toolset) pairs** (`composed-prebuild-volumes.md` §5
  rung 1). That reintroduces the combinatorial matrix — a partial N×M of
  materialized snapshots with cross-invalidation — which this design makes
  *unnecessary*: if compose-at-boot is already ≈ a CoW clone, there is
  nothing to pre-bake. We collapse the ladder to **two rungs**:
  compose-at-boot (fast) and rung-3 cold build.
- **No incremental quick wins** (zstd/stream/parallel of the current tar
  path). This proposal replaces that path; the quick wins would be throwaway
  against it.
- **No repo-on-its-own-mount split** (the "other drive" idea). Defensible
  but orthogonal to the speed win, and not free: it doubles PVCs/hotplugs/
  snapshot lineages and forces a prebuild-format migration. Deferred until a
  concrete need (e.g. repo-on-faster-storage) appears.

---

## 2. Why not the obvious alternatives

Two intuitive fixes were considered and rejected up front, because getting
this wrong is the whole trap:

**Tools as an OCI *image* layer (let containerd overlay them for free).**
This is a runc intuition. Under Kata CLH the container rootfs crosses a VM
boundary (block device or virtiofs), so containerd-managed overlay lowers
are **not visible inside the guest as composable mounts**. The routes in
would be K8s image-volumes (KEP-4639, alpha, Kata support unproven) or
virtiofs-sharing host overlay dirs (metadata-heavy npm over virtiofs is the
slow path again). Not viable as the near-term mechanism in this stack.

**Overlay lowers sourced from a tar-extracted per-sandbox dir.** "Overlay =
zero-copy" is only true if the lower bytes already exist *mountable*. If the
agent must `oras pull` + untar into a per-sandbox lowerdir first, the
extraction has moved, not vanished. **The artifact format is the load-bearing
change**, not the overlay itself.

The design below therefore combines two changes that only work together:
**(a) a mountable artifact format (squashfs)** and **(b) an overlay home that
stacks those blobs as read-only lowers over a writable PVC upper**.

---

## 3. Target mount topology

Today (`kube.resources.ts:82-90`, `VM.HOME = /home/dev` from
`packages/shared/src/constants/infra.ts:3`): the home PVC is mounted
**directly at `/home/dev`**. Because the PVC shadows the image, the image
home is stashed in `/home/skel` and copied back on first boot
(`sandbox-boot.sh:9-12`), and the toolset is extracted into the PVC.

Proposed:

```
PVC mounts at  /data                          (was: /home/dev)
  /data/upper/        overlay upperdir  — all writes land here (repo, edits, copy-ups)
  /data/work/         overlay workdir
  /data/toolsets/     <digest>.sqfs blobs — pulled once, on the PVC

/home/skel          image home skeleton (READ-ONLY, lowest lower) — no longer copied
/run/toolsets/<digest>/   loop-mount point per squashfs blob (tmpfs, ephemeral)

mount -t overlay overlay /home/dev \
  -o lowerdir=<blobN>:<…>:<blob1>:/home/skel,upperdir=/data/upper,workdir=/data/work
       #        ^ later toolsets = higher priority (leftmost wins), skel is the floor
```

Consequences:

- **The toolset is a mount, not a copy.** File count is irrelevant.
- **The skel copy disappears.** `/home/skel` becomes the lowest lower
  directly; `sandbox-boot.sh:9-12` and `sandbox-init.sh` Phase 1b are
  deleted, and the `dev-base` "home must be empty in the image" hack
  (`infra/images/dev-base/Dockerfile`, last stage `mv /home/dev
  /home/skel`) is no longer required for the mount reason (skel stays as the
  lower source).
- **The repo still lands in the writable upper.** `WORKSPACE_DIR =
  /home/dev/workspace` (`infra.ts:7`) resolves through the overlay into
  `/data/upper/workspace` — on the PVC, snapshottable, CoW-cloneable.
  Repo prebuilds remain whole-PVC (`/data`) snapshots.
- **Blobs live on the PVC**, so a pause `VolumeSnapshot` carries them (see
  §6) — resume never depends on zot.

### Guest capability check (prerequisite)

Guest-side block/loop mounting is **already a capability**: PID-1 mounts
`/dev/vdb` ro at `/opt/shared` (`sandbox-init.sh` Phase 1), and the
container runs as root (`kube.resources.ts` `securityContext: { runAsUser: 0
}`). Overlay + loop mounts need `CAP_SYS_ADMIN` (root has it) and guest
kernel support. **Verify in the Kata guest kernel before building:**

- `CONFIG_OVERLAY_FS=y`
- loop + squashfs: `CONFIG_BLK_DEV_LOOP=y` + `CONFIG_SQUASHFS=y`
  (+ `CONFIG_SQUASHFS_ZSTD=y` for zstd-compressed squashfs), **or**
- **EROFS** (`CONFIG_EROFS_FS=y`) — often already built into modern
  kernels, mountable directly from a file via loop, and where the ecosystem
  is heading (composefs/EROFS: verifiable, page-cache-shared, overlay-native
  RO layers).

If neither in-kernel option is present, `squashfuse`/`erofsfuse` (userspace)
is a fallback but adds a FUSE hop — prefer fixing the kernel config. **Keep
the format pluggable**: the artifact media type carries the format, and the
only code difference is the mount command (`mount -t squashfs` vs `mount -t
erofs`). Start with whichever the guest kernel already supports.

---

## 4. Artifact format change (build + capture)

`apps/agent-v2/src/toolset.rs` today tars + gzips + `oras push`es
(`build()`:159-236, `capture()`:298-410) with
`LAYER_TYPE = "…layer.v1.tar+gzip"` (`toolset.rs:13`). Change the packaging
tail only:

- `build()` / `capture()`: replace `tar -czf … | oras push …:<tar+gzip>`
  with

  ```
  mksquashfs <selected paths, staged> <name>.sqfs -comp zstd [-e <excludes>]
  oras push --plain-http <target> --artifact-type <ARTIFACT_TYPE> \
    <name>.sqfs:application/vnd.atelier.toolset.layer.v1.squashfs
  ```

  `mksquashfs` takes a source tree; stage the declared `paths[]` (relative
  to `/home/dev`) into a temp root first, or use `-e` excludes + explicit
  path args. The **secret scan** (`capture()`, `SECRET_PATTERNS`,
  `DEFAULT_EXCLUDES`, `SCAN_EXCLUDE_DIRS`) and the exclude-floor logic are
  **unchanged** — they run before packaging regardless of container format.
- `LAYER_TYPE` becomes the squashfs (or erofs) media type; digest parsing
  (`parse_digest`) is format-agnostic and unchanged.
- `mksquashfs` must be added to `dev-base` (`apt-get install squashfs-tools`;
  `erofs-utils` if EROFS).

Build/capture stay **single-file, sequential, compressed** — and produce a
blob that is *mountable*, which is the entire point. Content-addressing
(`hashToolset`, `runtime.service.ts:1353+`) and the store are unaffected: a
`ToolsetRecord` still points at `toolsets/<name>@sha256:<digest>`
(`store.ts:76-87`).

> Note: squashfs is deterministic enough for content-addressing if
> `mksquashfs` is invoked with reproducible flags (`-no-exports`,
> pinned timestamps via `-mkfs-time`/`-all-time`, sorted). Pin these so the
> `built`-path content hash stays stable across rebuilds.

---

## 5. Materialize → pull-blob + loop-mount + overlay

`materialize()` (`toolset.rs:411-431`) changes from extract to mount. It runs
as **root** (not `dev` — mounts need it), and remains the boot seam the
runtime calls (`agent.materializeToolsets`,
`apps/server/src/runtime/agent/agent.client.ts:363-371`; invoked
`boot.ts:127-139`). New behavior, given the ordered digest-pinned refs:

```
for ref in refs:                      # order preserved; later = higher overlay priority
  digest = digest_of(ref)
  blob = /data/toolsets/<digest>.sqfs
  if not exists(blob):                # idempotent: present on resume / warm PVC
    oras pull --plain-http <ref> -o /data/toolsets   # ONE sequential file
  mkdir -p /run/toolsets/<digest>
  mount -o ro <blob> /run/toolsets/<digest>          # loop / erofs
assemble overlay /home/dev with lowerdir = <mounts, reverse order>:/home/skel,
  upperdir=/data/upper, workdir=/data/work
```

No per-file writes ever touch the PVC for the toolset; the only PVC write is
the sequential blob pull (skipped entirely when the blob is already there).

### Boot ordering (the main implementation risk)

The overlay must be assembled **before** `files[]`/processes use `/home/dev`
— it already sits before the files phase in `boot.ts:120-139`. Two ordering
hazards, and the recommended resolution:

1. **The entrypoint touches `/home/dev` before the agent runs.**
   `sandbox-boot.sh` writes `~/.ssh/authorized_keys` and starts `sshd`
   (`:18-33`) before exec-ing the agent. Under the new topology `/home/dev`
   is not usable until the overlay is mounted. **Resolution:** the entrypoint
   mounts a **base overlay early** — `lowerdir=/home/skel,
   upperdir=/data/upper, workdir=/data/work` — which is always safe and
   instant (skel always exists in the image; no toolset needed yet). SSH
   setup then writes into the merged view (lands in `/data/upper/.ssh`) and
   survives the later re-lower.

2. **Adding toolset lowers means re-mounting the overlay.** overlayfs cannot
   append lowerdirs via `mount -o remount`. **Resolution:** at boot phase 0
   (before any files/processes, before user SSH sessions), the agent
   `umount /home/dev` + re-mounts with the full lower stack. This is safe
   *only* pre-file-phase, when nothing holds `/home/dev` busy (agent keeps
   its cwd elsewhere; no user process has started). Gate the file/process
   phases on materialize completion (already the case). If a user SSHes mid-
   boot, `gateOnPrimary`/reconcile ordering must hold them until phase 0 is
   done — verify.

   *Alternative considered:* pass the resolved toolset refs to the entrypoint
   (downward API / agent config) and mount the full stack **once** in the
   entrypoint, pulling blobs there. Rejected for now: pulling from zot needs
   the registry config the runtime pushes *after* boot, and it moves
   orchestration out of the agent where the retry/observability lives. The
   umount+remount-once approach keeps all toolset logic in the agent.

`materialize` becomes **idempotent** (mount-only when blobs+upper already
exist), which is what makes resume trivial (§6).

---

## 6. Pause / resume

Current resume **skips** materialize because the extracted bytes are in the
pause snapshot (`boot.ts:53-57`; `BootInput.toolsets` set on create only —
`runtime.service.ts:501` sets it, `resume()`'s boot call `RS:620-633` omits
it). Pause = `snapshotPvc` + keep PVC (`pause()` RS:565-589;
`deleteRestartableResources` keeps the PVC, `boot.ts:203-221`).

Under the new topology:

- **Blobs are on `/data`**, so the pause `VolumeSnapshot` of the PVC carries
  both the toolset blobs (`/data/toolsets`) **and** the user's edits
  (`/data/upper`). **Resume never contacts zot.**
- Resume must **re-mount the overlay** from PVC-local blobs (loop-mount each
  `/data/toolsets/*.sqfs` + overlay assemble) — it must **not** re-pull or
  re-extract. Because materialize is idempotent (§5), the same call is safe:
  on resume the blobs already exist, so it degrades to pure mount. So
  `resume()` should now pass `toolsets` into its `bootSandbox` call (today it
  omits them), OR the mount step reads the persisted digest list (below).
  Recommended: persist + re-mount, independent of registry availability.
- The `preserveDisk`/`reusePvc` precedence (`resume()` RS:612-633) is
  unchanged: reuse live disk > clone pause snapshot > clone source snapshot.
  In every branch the blobs come along with `/data`.

**Storage:** pause snapshots fatten by toolset size (as
`composed-prebuild-volumes.md` §5 already accepted) — but now as **one
dedupe-friendly compressed blob per toolset**, not thousands of inodes.
Strictly better, and CoW-shareable across a prebuild lineage.

### Persist the mounted digest list

The runtime cannot today answer "which toolsets does sandbox X have
mounted?" without deserializing `sandboxes.spec` JSON — there is **no
queryable column** (`runtime/db/schema.ts:20-34`; scout-confirmed). Resume
and GC (§7) both need it. Add one of:

- **(recommended)** a side table `sandbox_toolset_refs(sandboxId, ref,
  digest)` — supports both "re-mount these on resume" and "is this ref
  referenced?" with an index; mirrors how `snapshots.sandboxId`
  (`runtime/db/schema.ts:36-58`) already enables ownership queries, but
  many-to-many (one toolset shared by many sandboxes), and
- resolved at create from `resolveSpecToolsets` (`RS:1115-1120`), where the
  digest-pinned refs already exist.

---

## 7. GC correctness

`deleteToolset(ref)` (`runtime.service.ts:1034-1040`, exposed unguarded at
`v1.routes.ts:204-209`; driven by `pruneToolboxVersions`,
`container.ts:242-263`) has **no reference check** — unlike `deletePrebuild`,
which "refuses when the snapshot is still referenced by a sandbox or a
chained prebuild" via `referencedSnapshotRefs()` (`RS:192-208`).

- **Blobs-on-PVC removes the fatal case for resume**: a paused sandbox
  re-mounts from its own `/data`, so deleting the zot artifact / runtime
  record can't break resume. This is the single biggest de-risking of the
  overlay approach — the classic "GC'd artifact = unresumable sandbox"
  failure mode is gone.
- **Still add `referencedToolsetRefs()`** and guard `deleteToolset` (and the
  DELETE route) to refuse dropping a record a live/paused sandbox references
  — for correctness of the runtime handle and to keep `getByRef`/compose
  lookups from 404-ing. Backed by the §6 side table.
- zot retention may still sweep an *unreferenced* blob freely — safe, since
  live sandboxes hold their own copy on the PVC.

---

## 8. Tooling edge cases (overlay semantics)

The merged `/home/dev` is **read-write** (copy-up on modify, whiteout on
delete), so extensions and tools that write to their own config/data dirs
work unchanged. Known overlayfs behaviors to validate per harness (none are
blockers):

- **`rename()` across layers returns `EXDEV`.** Some installers `mv` a
  directory that lives in a lower. Most tolerate `EXDEV` (fall back to
  copy); flag any that don't.
- **pnpm/npm hardlink-from-store.** Hardlinks from a lower store into an
  upper `node_modules` fall back to copy — correctness fine, some space cost.
- **Mass copy-up.** `pi update --all` (or any tool rewriting a large lower
  tree) copies every touched file up into `/data/upper` — a one-time,
  amortized cost; the *next* capture re-flattens it into a blob.
- **Capture stays correct.** `captureToolset` tars/squashes the **merged
  view** (`-C /home/dev`), so click-to-new-version sees lower+upper unified;
  a captured toolset re-includes unmodified lower files (self-contained by
  design — fine).

---

## 9. Migration

The change spans the image (`dev-base`), the pod spec (`kube.resources.ts`),
the entrypoint (`sandbox-boot.sh`), and the agent (`toolset.rs`). Existing
sandboxes booted on the old topology have their toolset extracted into a
`/home/dev` PVC. Approach:

1. **Gate by image/agent version.** New-topology pods mount the PVC at
   `/data` and run the overlay entrypoint; old pods keep PVC-at-`/home/dev`.
   The pod spec's `mountPath` is chosen from the resolved image's capability
   (image tag or an `image.json` flag), not globally flipped.
2. **New sandboxes** use the new path immediately. **Existing paused
   sandboxes** resume on the old path (their PVC is `/home/dev`-shaped);
   they migrate naturally on next destroy+recreate. No online conversion.
3. **`materialize` detects topology** (presence of `/data` mount / a flag)
   and either mounts (new) or extracts (old) — a bounded compatibility
   branch removed once all live sandboxes have cycled.
4. **Toolset artifacts:** rebuild org/personal toolboxes into squashfs blobs
   (the `built` path re-runs from recipe; `captured` ones re-capture). Old
   `tar+gzip` artifacts can coexist (media type distinguishes them) during
   the transition; drop tar support after cutover.

---

## 10. Build plan (hard-sequenced)

1. **Guest kernel check** — confirm overlay + squashfs (or erofs) + loop in
   the Kata guest kernel. Blocks everything; do first. Add `squashfs-tools`
   (and/or `erofs-utils`) to `dev-base`.
2. **Pod topology** — PVC `mountPath` → `/data` behind an image-capability
   flag (`kube.resources.ts:82-90`); keep `/home/dev` path for old images.
3. **Entrypoint** — `sandbox-boot.sh`: create `/data/{upper,work,toolsets}`,
   mount base overlay at `/home/dev`, move SSH setup to the merged view,
   delete the skel `cp -a`. Keep `/home/skel` as the lower.
4. **Agent build/capture** — `toolset.rs` `build`/`capture` tail →
   `mksquashfs` + squashfs media type; keep the secret scan. Pin reproducible
   `mksquashfs` flags for the `built` content hash.
5. **Agent materialize** — pull-blob + loop-mount + overlay re-mount
   (root, idempotent). Topology-detect for old sandboxes.
6. **Persistence + resume** — `sandbox_toolset_refs` side table; `resume()`
   passes/re-mounts toolsets; verify no re-pull, no clobber.
7. **GC guard** — `referencedToolsetRefs()` + guard `deleteToolset` and the
   DELETE route.
8. **Migration cutover** — rebuild toolboxes as blobs; retire the tar path
   and the compatibility branch once all sandboxes have cycled.

---

## 11. Open questions

- **umount/remount race** (§5): is `gateOnPrimary`/reconcile guaranteed to
  hold a mid-boot SSH session out of `/home/dev` until phase 0 completes? If
  not, prefer the entrypoint-mounts-once alternative despite its registry-
  config cost.
- **Repo prebuild carries stale blobs** (§3): a `/data` prebuild snapshot
  includes whatever `/data/toolsets/*.sqfs` were present at prebuild time.
  Booting that prebuild with a *different* toolset pulls the new blob and
  leaves the old one as dead weight on the clone. Cheap (one compressed
  file), but add a boot-time sweep of `/data/toolsets/*.sqfs` whose digest
  isn't in the current mount set.
- **squashfs determinism** for content-addressing (§4) — validate the pinned
  flag set produces stable digests across nodes/rebuilds, else the `built`
  dedup key drifts.
- **EROFS vs squashfs** as the first format — decide on the guest kernel's
  existing support; keep the media type pluggable either way.

---

## 12. Summary

| Change | From | To |
|---|---|---|
| Artifact format | `tar+gzip` layer | `squashfs` (or `erofs`) blob |
| Materialize | `oras pull` + `tar -xzf` (per-file writes) | pull one blob + loop-mount + overlay |
| Home | PVC at `/home/dev` + skel `cp -a` | PVC at `/data`; overlay(`skel`+blobs, upper) at `/home/dev` |
| Skel copy | `cp -a /home/skel/.` every boot | gone (skel is the lowest lower) |
| Resume | skip (bytes in snapshot) | re-mount blobs from PVC — no zot |
| Composition | N + M (extract product at boot) | N + M (mount product at boot) |
| Baked pairs (rung 1) | proposed cache | **dropped — unnecessary** |

The inversion instinct — "tools = the base, repo = the payload" — lands
correctly as **tools = read-only mountable lowers, repo = writable PVC
upper**. Squashfs makes the lower *mountable*; the overlay stacks it in
zero-copy; storing the blob on the PVC makes resume registry-independent.
Composition stays sum-shaped, boot stops caring about file count, and the
second (skel) copy tax dies for free.
