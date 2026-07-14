# Independent Review — Toolset Overlay/Squashfs Cutover (reviewer: claude-fable-5)

> Saved verbatim for later retrieval. Reviewer model: `anthropic/claude-fable-5`.
> Reviews the implemented change against `docs/proposals/toolset-overlay-squashfs.md`.
> Status at review time: implementation complete, two prior reviewers' 8 findings already fixed.

Scope reviewed: `git diff` (16 files) + untracked `apps/server/drizzle/0017_fancy_lyja.sql`,
`apps/server/drizzle/meta/0017_snapshot.json`, against
`docs/proposals/toolset-overlay-squashfs.md`. Constraints honored: no
migration/topology-gate re-litigation; guest-kernel overlayfs+squashfs+loop
treated as a known deploy prerequisite.

Verdict up front: **DON'T SHIP yet.** The architecture is right and the prior
fixes (single-assembly handshake, atomic same-fs blob rename, digest
validation, GC guard, ref bookkeeping) are solid — but I found two boot-path
defects that will fail loudly on the first real (non-mock) boot, plus one
resilience gap. All are small, targeted fixes.

> **Parent verification note:** CRITICAL-1 and CRITICAL-2 were independently
> confirmed against the code by the orchestrator. `/data/upper` is only ever
> chowned at its `.ssh` subdir (`sandbox-boot.sh:35`), never the upper root;
> the pod `securityContext` is `{ runAsUser: 0 }` only (`kube.resources.ts:59`);
> and the pod command is `sandbox-boot.sh`, NOT `sandbox-init.sh` (so the
> `/dev/vdb` mount cited in design §3 never runs in this path). The passing
> lifecycle tests run in `isMock` mode and never exercise a real mount or the
> overlay's ownership — which is how these escaped the prior passes.

---

## Findings (severity-ranked)

### CRITICAL-1 — Merged `/home/dev` root is root-owned: `dev` cannot create anything at the top of its own home; prebuilds break on day one

- Where: `infra/images/dev-base/rootfs/etc/sandbox/sandbox-boot.sh:22`
  (`mkdir -p /data/upper /data/work /data/toolsets`, running as root, no
  chown) and `apps/agent-v2/src/toolset.rs:598` (`mkdir -p {upper} {work}`,
  also root).
- Mechanism: for a directory present in the upperdir, overlayfs surfaces the
  **upperdir's** uid/gid/mode as the merged directory's attributes. A fresh
  `/data/upper` is created `root:root 0755`, so the assembled `/home/dev`
  is owned by root with no group/other write. The old boot path explicitly
  fixed this (`chown -R 1000:1000 /home/dev` in the deleted skel-copy branch,
  old `sandbox-boot.sh:9-12`); the new path never chowns the upper root. The
  only chown that survived is `.ssh` (`sandbox-boot.sh:35`) — the reviewers
  fixed ownership for the one path sshd checks and missed the home root
  itself.
- Concrete breakage:
  - `executePrebuild` → `runPrebuildSteps` runs `git clone … <clonePath>` **as
    `dev`** (`runtime.service.ts:434-447`, comment even explains why root
    would be wrong). `workspace/` is not in skel (Dockerfile creates only
    `.local`, `.config/opencode`, `.cache/...`), so git must create
    `/home/dev/workspace` → `EACCES`. Every prebuild fails.
  - Interactive: `~/.bash_history`, `~/.npm`, any *new* top-level dotfile →
    permission denied. (Writes *inside* existing skel dirs still work — the
    copy-up preserves the lower dir's dev ownership — which will make this
    intermittent-looking and confusing.)
  - sshd itself still works (StrictModes accepts a root-owned home), so the
    failure is silent at the SSH layer.
- Fix: one line in `sandbox-boot.sh` (or the agent's overlay script):
  `chown 1000:1000 /data/upper` (before or after the mkdir; idempotent across
  resumes). Do NOT `chown -R` — copied-up content must keep its ownership.
  `/data/work` should stay root-owned (kernel-internal).

### CRITICAL-2 — Nothing grants the container the ability to mount: no `CAP_SYS_ADMIN`, no loop devices in the pod spec

- Where: `apps/server/src/runtime/kube/kube.resources.ts:130` —
  `securityContext: { runAsUser: 0 }` only. No `privileged: true`, no
  `capabilities: { add: ["SYS_ADMIN"] }`, no device access.
- Mechanism: `runAsUser: 0` gives uid 0 with the **default OCI capability
  set**, which does not include `CAP_SYS_ADMIN`. Kata's guest agent applies
  the OCI process capabilities to the container process inside the VM, so
  "the guest runs as root" does not by itself confer mount rights on the
  *container* process the sandbox-agent runs as. Additionally `mount -o loop`
  needs `/dev/loop-control` (or pre-created `/dev/loopN`) in the container's
  `/dev`, which the runtime-populated tmpfs `/dev` does not contain.
- Why I don't consider this covered by the "kernel config is a known
  prerequisite" carve-out: kernel config, capabilities, and device nodes are
  three independent axes; the design doc (§3 "Guest capability check") cites
  `sandbox-init.sh` PID-1 mounting `/dev/vdb` as evidence — but that script
  runs as VM init (full caps, mknods its own devices), a different privilege
  context from the container process the agent is. Nothing in this repo has
  ever performed a mount from *inside the container* before this change; the
  old materialize was pure tar-as-dev. This is untested ground and the most
  likely first-deploy failure (`mount: permission denied` / "failed to set up
  loop device").
- Fix: add `capabilities: { add: ["SYS_ADMIN"] }` (cheap under Kata — the VM
  is the isolation boundary) or `privileged: true` to the sandbox container,
  and verify `/dev/loop-control` exists in-container (Kata may pass the guest
  devtmpfs; if not, the agent has `CAP_MKNOD` and can
  `mknod /dev/loop-control c 10 237` before the first loop mount — or bake
  that into `sandbox-boot.sh`). **Pre-ship verification:** in a booted
  sandbox, `capsh --print` + `mount -t squashfs -o ro,loop <blob> /mnt-test`.
  If your specific Kata config already yields full caps, downgrade this to
  "confirmed by test" — but it must be tested before cutover, and the pod
  spec should still say what it means.

### HIGH-1 — Container restart (agent crash) permanently strands the sandbox on an unassembled `/home/dev`

- Where: `sandbox-boot.sh:42-56` + `kube.resources.ts` (no `restartPolicy` →
  default `Always`) + the runtime only ever calling materialize from
  `bootSandbox` (`boot.ts:146`).
- Mechanism: in the K8s path there is no in-container agent supervision (the
  supervision loop lives in `sandbox-init.sh`, which is not the pod
  entrypoint). If the agent panics/OOMs, `sandbox-boot.sh`'s wait loop exits,
  PID 1 exits, kubelet restarts the container. The new container instance
  has: no overlay mount (fresh mount namespace), no `/run/home-ready`, no
  persisted agent config (`/run/atelier-agent/config.json` was on the old
  container's ephemeral state). The runtime does not know the container
  restarted and never re-calls materialize. After the 60 s timeout, sshd
  starts against the **bare rootfs `/home/dev`** — users land in an empty
  home and any writes go to the ephemeral rootfs and are silently divorced
  from the PVC. The old topology degraded gracefully here (PVC was `/home/dev`
  directly; home survived a container restart). This is a real resilience
  regression the single-assembly design introduces and neither the doc nor
  the prior fixes address.
  (Note: an *agent-process* restart within a live container is fine — mounts
  belong to the namespace, not the process. The gap is whole-container
  restart.)
- Fix options (pick one):
  1. Agent persists the last successful materialize request to
     `/data/` (it survives) and, on startup, when `/run/home-ready` is
     absent but `/data/upper` exists, re-runs the assembly locally
     (blobs are already on the PVC — no registry needed). Cleanest; keeps
     the "agent owns assembly" invariant.
  2. `restartPolicy: Never` + a reconcile loop that flips the record to
     `error` when the pod is not Running, funneling recovery through
     `resume()` (which re-drives materialize). Heavier, changes pod
     lifecycle semantics.

### MEDIUM-1 — 60 s sshd gate vs 600 s materialize budget: a legitimately slow first pull exposes (and lets users write to) the wrong `/home/dev`

- Where: `sandbox-boot.sh:53-56` (120 × 0.5 s) vs `toolset.rs:38`
  (`BUILD_TIMEOUT_MS = 600_000`) and `agent.client.ts:379` (600 s HTTP
  timeout).
- A cold-cache pull of a multi-hundred-MB toolset can exceed 60 s without any
  failure. sshd then starts on the bare `/home/dev`; when materialize
  finishes it mounts the overlay **over** the directory — pre-existing shell
  sessions keep the stale (empty) view via their cwd, and anything they wrote
  is shadowed/lost. This isn't only the "boot is failing anyway" case the
  comment claims — it's a normal-path race for large toolsets.
- Fix: make the entrypoint wait bound match the materialize budget (~600 s),
  or better, have the agent write a distinct `/run/home-failed` marker on
  materialize error so the entrypoint can start sshd immediately on genuine
  failure and wait indefinitely otherwise.

### MEDIUM-2 — Staging doubles the packaging disk footprint on the ephemeral rootfs

- Where: `toolset.rs:265-295` — `squash_and_push_script` rsyncs a **full
  uncompressed copy** of the declared path-sets into `/tmp` (`STAGE_DIR`,
  container ephemeral rootfs), then writes the `.sqfs` next to it. The old
  path wrote only the compressed tarball. For node_modules-heavy toolsets
  this is uncompressed-tree + compressed-blob of extra ephemeral usage, with
  no `ephemeral-storage` limit/request on the pod and a possibly small
  Kata rootfs. `ENOSPC` mid-capture is plausible.
- Fix: stage under `/data` (PVC — sized for the sandbox, and the scratch is
  removed by the trap), or at least document/size the rootfs for 2× the
  largest expected toolset.

### MEDIUM-3 — Crashed pulls leak `atelier-toolset-pull.*` scratch dirs onto the PVC forever

- Where: `toolset.rs:545` (scratch created under `/data/toolsets`, cleaned
  only by an EXIT trap) vs `sweep_stale_blobs_script` (`toolset.rs:661-679`)
  which matches only `-name '*.sqfs'` files.
- A SIGKILL/VM-death mid-pull skips the trap; the partial blob sits in a
  scratch dir on the PVC, rides every pause snapshot and prebuild clone, and
  is never swept (the sweep's stated purpose — §11 "dead weight on the
  clone" — has a hole for exactly the failure it was designed around). The
  same-fs `mv` correctly protects the *final* path; the *scratch* residue is
  the leak.
- Fix: at materialize start (single writer per PVC, so it's safe), remove
  `"$DATA_TOOLSETS"/atelier-toolset-pull.*` before pulling, or include the
  dirs in the sweep.

### LOW-1 — Duplicate toolset refs/digests produce duplicate `lowerdir` entries

- `SandboxSpecSchema.toolsets` is a plain array (no uniqueItems,
  `sandbox-spec.ts:211`); two entries with the same digest (same ref listed
  twice) make `materialize` push the same `/run/toolsets/<digest>` mount
  point twice into `mounts` (`toolset.rs:576-577`; the `mountpoint -q` guard
  skips the second *mount* but not the second *list entry*), yielding
  `lowerdir=X:X:...`. Overlayfs behavior with duplicate lowers is at best
  wasteful and at worst mount-refusing on some kernels. Fix: dedupe digests
  while preserving first/last-wins order (one-liner before the reverse).

### LOW-2 — Cross-path-set hardlinks are duplicated at staging time

- `rsync -aH` preserves hardlinks only **within one invocation**; the script
  invokes rsync per declared path (`toolset.rs:277-281`). The old
  `tar -C home p1 p2` was a single invocation and preserved links across
  path-sets (pnpm store ↔ node_modules split across two declared paths).
  Blob size is rescued by mksquashfs's default content dedup, so the cost is
  staging-disk only (compounds MEDIUM-2). Informational; a comment fix or a
  single `rsync --relative` invocation would close it.

### LOW-3 — rsync exclude semantics diverge from tar for slash-containing globs

- `rsync_exclude_flags` (`toolset.rs:317-330`) claims parity with tar, and
  that's true for the built-in slash-free globs — but a compose-declared
  `exclude` containing `/` is anchored to the per-path transfer root in
  rsync (and each declared path is a separate transfer root here), whereas
  tar matched it anywhere in the path. Silent behavior change for user
  excludes like `config/secrets`. Fix: document, or reject slash-bearing
  excludes, or normalize to `**/<glob>`.

### LOW-4 — `sandbox_toolset_refs` is written only after postStart: a create-in-flight doesn't block `deleteToolset`

- `runtime.service.ts:521` persists refs after `postCreate → reconcile →
  gateOnPrimary → postStart`. During that window (can be minutes),
  `deleteToolset` passes the guard for a ref the booting sandbox is using.
  Consequence is bounded (the blob is already on the sandbox's PVC; only the
  runtime record 404s later), and resume doesn't consult the record — so I
  agree with treating it as minor, but moving `putForSandbox` to immediately
  after a successful `bootSandbox` (materialize done ⇒ mounted) would close
  it for free and is more truthful ("mounted" happens at materialize, not
  postStart).

### LOW-5 — `sandbox-init.sh` (if still a live boot path anywhere) has no home-ready handshake

- `sandbox-init.sh` starts sshd unconditionally in Phase 3 and exports
  `PATH=/home/dev/.bun/bin` etc. It self-describes as "PID 1 inside Kata
  Containers VM" and was touched by this change (Phase 1b deleted), implying
  it's considered live — yet it embodies none of the new handshake. If it's
  the v1/legacy path only, say so in a header comment or delete it; if any
  deployment mode still uses it as init, it boots sshd against an
  unassembled home by design.

### INFO-1 — Overlay lower-stack changes under a persisted upper are formally "offline modification"

- Changing the toolset selection across resume swaps lowerdirs under the same
  `/data/upper`. Kernel docs call offline lower changes undefined; with the
  defaults used here (no `index`, no `metacopy`, no `redirect_dir`) the
  practical effects are benign (upper copies shadow new lower content;
  `st_ino` may change for lower files across boots). Worth one sentence in
  the design doc; no code change needed.

### INFO-2 — Reproducible-mksquashfs claim: correctly non-load-bearing

- Verified nothing depends on byte-reproducibility: `hashToolset`
  (`runtime.service.ts:1433+`) hashes the *build request*, captured toolsets
  are never deduped, and the blob filename is keyed by the *manifest* digest
  oras reports post-push. The long code comment at `toolset.rs:258-267` says
  exactly this and even flags multithreaded block-layout nondeterminism.
  Agreed on all counts. (Also checked: `-all-time`/`-mkfs-time` require
  squashfs-tools ≥4.5; bookworm's 4.5.1 in `node:22-slim` has them.)

---

## Confirmed correct (things I tried to break and couldn't)

1. **Handshake, single-container happy path.** The marker is created by the
   same `set -euo pipefail` script *after* the overlay mount
   (`toolset.rs:596-604`); there is no path where `/run/home-ready` exists
   without a fully assembled `/home/dev` within one container instance, and
   no path where assembly succeeds without the marker (barring a failed
   `: >`, which also fails the script). Mount failure ⇒ no marker ⇒
   materialize error ⇒ boot fails server-side ⇒ pod cleaned. The
   entrypoint never touches `/home/dev` before the marker (SSH keys go to
   `/data/upper/.ssh` — correct overlay semantics; they surface in the
   merged view). `waitForAgent` (120 s) probes the agent's TCP health, which
   is up before materialize — no interlock problem there.
2. **Ordering.** `mounts` pushed in ref order then reversed
   (`toolset.rs:582`), skel appended as the floor — leftmost-lowerdir-wins
   matches the documented later-ref-wins rule and the `files[]` convention.
   `files[]` awaits materialize (`boot.ts:155-158`); `putConfig` runs
   concurrently but the supervisor does not autostart on config push (only
   the forwarder subscribes; process start is the explicit later
   `/reconcile`) — so no process can touch `/home/dev` pre-assembly.
3. **Blob lifecycle.** Digest-validated filename (`digest_suffix` hard-fails
   malformed refs before any root-run path use, with tests); scratch dir on
   the same filesystem so the final `mv` is an atomic `rename(2)`;
   skip-if-present is sound; the sweep runs only after successful assembly
   and only `-maxdepth 1 -name '*.sqfs'` outside the keep set; empty keep-set
   deletes everything (correct). Shell quoting is consistent (`sh_quote`
   everywhere user-adjacent; lowerdir components are internally generated
   hex/fixed paths with no `:` or quoting hazards).
4. **Per-PVC blob isolation holds.** `pvcName = sandbox-<id>` (one PVC per
   sandbox, `boot.ts:88`); prebuild clones are CoW-independent copies; pause
   snapshots are per-sandbox. No cross-sandbox path exists by which one
   sandbox's sweep can remove a blob another needs. The doc's §11 "stale
   blobs on prebuild clones" concern is correctly answered by the sweep.
5. **Pause/resume integrity.** Blobs + upper ride the `/data` snapshot;
   resume passes `toolsets` into boot (`runtime.service.ts:640,656`) and the
   pull is skipped when the blob exists — resume is registry-independent as
   designed. Upper edits can't be clobbered by re-mounting RO lowers.
   `pauseSnapshotRef` is cleared only after a fully successful resume,
   inside the op lock; failure restores prior status and keeps the disk
   (`preserveDisk: true`).
6. **Server bookkeeping.** `putForSandbox` is transactional
   (delete+insert in one tx, `store.ts:487-503`); refs cleared on destroy
   and both `reconcileOnStartup` sweeps; paused sandboxes keep their rows
   (tested); `deleteToolset` 409s via `ConflictError` → shared onError maps
   `statusCode`; `pruneToolboxVersions`' swallowing catch handles the new
   Conflict correctly (`container.ts:263-270`). `toRefEntries`' digest slice
   is correct for schema-validated refs. All ops are under `withOpLock`.
7. **Migration artifacts.** `0017_fancy_lyja.sql` matches the schema;
   `_journal.json` idx 17 appended; `0017_snapshot.json.prevId` chains to
   0016's id (verified programmatically).
8. **Secret scan** unchanged and still runs before packaging; the
   `node_modules`-scan-only-exclude invariant is preserved and tested.
9. **Tests pass:** `bun test runtime.lifecycle.test.ts` — 14 pass (incl. 7
   new toolset-ref/GC tests); `cargo test` in agent-v2 — 48 pass (incl. new
   `digest_suffix` accept/reject tests).
10. **workdir/upper same-fs requirement** satisfied (both under the `/data`
    PVC); workdir reuse across mounts is standard with `index=off`.

## Disagreements with implicit prior-review positions

- The comment at `sandbox-boot.sh:49-51` ("if materialize never completes …
  boot is failing regardless") is **wrong for the slow-pull case**
  (MEDIUM-1) and for the container-restart case (HIGH-1): both are
  non-failing boots where the 60 s fallback actively serves the wrong home.
- The `.ssh` ownership fix was treated as sufficient; it fixed the symptom
  sshd checks and left the underlying root-owned upper (CRITICAL-1).
- The design doc's §3 capability argument ("PID-1 mounts /dev/vdb … the
  container runs as root") conflates VM-init privilege with container
  privilege (CRITICAL-2); "verify in the Kata guest kernel" is necessary but
  not sufficient — verify the *container's* capset and loop-device access.

## Ship judgment

**DON'T SHIP** in the current state. CRITICAL-1 is a deterministic day-one
breakage of prebuilds and top-level home writes (one-line fix). CRITICAL-2 is
an unverified — and by static reading, failing — precondition for every mount
the new mechanism performs (one-line pod-spec fix + an in-cluster smoke
test). HIGH-1 should be fixed (or at minimum consciously accepted and
documented) before cutover because it converts a previously-survivable agent
crash into a silently-corrupting sandbox state. With those three addressed
(and ideally MEDIUM-1/-3, both trivial), the design and the rest of the
implementation are sound and I'd ship it: the artifact-format inversion is
correct, the single-assembly handshake is genuinely race-free within its
stated scope, and the server-side bookkeeping is careful and well-tested.

---

## Fix-tracking checklist (orchestrator)

All v2-scoped findings fixed and verified (cargo check + 48 Rust tests, bun
typecheck, biome clean on touched files, 14 lifecycle tests, `sh -n`).

- [x] **CRITICAL-1** — `chown 1000:1000 /data/upper` (not `-R`) in `sandbox-boot.sh` AND the agent overlay script (`toolset.rs`)
- [x] **CRITICAL-2** — added `capabilities: { add: ["SYS_ADMIN"] }` to the sandbox pod `securityContext`; `sandbox-boot.sh` mknods `/dev/loop-control` + `/dev/loop0..7`. **In-cluster smoke test DONE** (kata-clh, kernel 6.18.x): `cap_sys_admin` present ✅, `overlay` ✅, loop ✅, and `chown`-upper makes the merged home dev-owned ✅. BUT **`squashfs` is absent from the guest kernel** ❌ — `erofs` is present ✅. Fix: pivoted the blob format to be **auto-detected (erofs preferred, squashfs fallback)** via `BlobFormat` in `toolset.rs`; `dev-base` bakes both `erofs-utils` + `squashfs-tools`. This was the real ship-blocker CRITICAL-2 was pointing at — fable was right that “verify the container's actual mount capability” was necessary, not just kernel-config assumptions.
- [x] **HIGH-1** — agent self-heals: `materialize` persists the selection to `/data/toolsets/.materialize.json`; `self_heal_home` (spawned in `main.rs`) re-assembles from PVC-local blobs after a kubelet restart. Serialized by a process mutex + HOME_READY early-return so it no-ops whenever the runtime drives materialize
- [x] **MEDIUM-1** — `materialize` writes/clears `/run/home-failed`; `sandbox-boot.sh` waits for ready-OR-failed up to ~600s (matches `BUILD_TIMEOUT_MS`)
- [x] **MEDIUM-2** — staging moved to the PVC-backed home (`STAGE_DIR = HOME`), off the ephemeral rootfs
- [x] **MEDIUM-3** — `materialize` sweeps leaked `atelier-toolset-pull.*` scratch dirs at start
- [x] **LOW-1** — duplicate toolset digests deduped before building `lowerdir`
- [x] **LOW-3** — `capture` rejects slash-bearing user excludes (loud error, preserves tar-parity)
- [x] **LOW-4** — `putForSandbox` moved to immediately after `bootSandbox` in both create and resume
- [x] **LOW-5** — `sandbox-init.sh` marked LEGACY (not the K8s entrypoint) via header banner
- [x] **INFO-1** — design doc §6 now covers offline-lower-change semantics + the kubelet-restart self-heal

### Not code-changed (by design)

- **LOW-2** (cross-path-set hardlink duplication at staging) — informational; mksquashfs content-dedup rescues blob size, staging-disk-only cost now lands on the PVC (MEDIUM-2). Left as-is.
- **INFO-2** (reproducible mksquashfs non-load-bearing) — confirmed correct, no change needed.
