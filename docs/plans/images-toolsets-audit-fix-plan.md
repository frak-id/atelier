# Audit & Fix Plan — base-image build pipeline + toolset overlay rework

Scope: the two `feat/v2` reworks —
1. **Base image building from the live cluster** (`5db42005`→`f06e8a4d`): seeds,
   BYO Dockerfile / zip upload, kaniko/buildkit/docker builders, k8s build Jobs.
2. **Toolbox/toolset injection rework** (`412eec14` + follow-ups): zero-copy
   mountable blobs over an overlay home (`lowerdir=<blobs>:/home/skel`,
   `upperdir=/data/upper`), exec-as-dev, capture/build/materialize.

Cross-checked against the **durable job queue** (`b94d6aef`, `22010861`,
`986653f0`) and the **image-into-queue bridge** (`1652a6ee`, `aa816b89`), which
landed after the initial audit and change the remediation path for the
build-cancellation findings (see "Job-queue impact" below).

Status legend: ☐ not started · ◐ in progress · ☑ done

---

## Job-queue impact (read first)

The job queue (`JobService`, `apps/server/src/runtime/jobs.service.ts`) added a
durable, cancellable, concurrency-bounded pool and wired **prebuild bake**,
**toolset build**, and **toolset capture** through `jobs.dispatch(fn(signal))`
with real cooperative cancellation (`signal.throwIfAborted()` checkpoints in
`runtime.service.ts`, and `agent.client.ts` now combines the caller signal with
its per-request timeout via `AbortSignal.any`). Sandbox lifecycle ops go through
`jobs.track` (unpooled, non-cancellable).

`1652a6ee`/`aa816b89` then **bridged** image builds into the feed (they were NOT
merged): `ImageBuilderService` gained an `onBuildStarted(name, done)` hook that
the container wires to `jobs.track({ kind: "image-build" }, () => await done)`.
Execution, dedupe (`inflight`), `reconcileOnStartup`, logs, and the
`AbortController` all **stayed in `ImageBuilderService`** — the job only mirrors
the outcome for a single-pane feed. The same commits also made spawn
non-blocking (`POST /v1/sandboxes` → unpooled `sandbox-create` dispatch, 202 +
job) and added per-job log ring buffers (`GET /v1/jobs/:id/logs`).

What this changes for the earlier findings:

- **Image build feed visibility: done.** But because the bridge uses `track`
  (unpooled), image builds are **non-cancellable** through the queue
  (`JobService.cancel` 409s tracked jobs), and the `AbortController` at
  `image-builder.service.ts:350` is **still created and never aborted** — no
  docker-backend timeout, no cancel path. `deleteImage` **still has no
  `building` guard**. So C1 shrinks from "converge onto the queue" to "close the
  two correctness gaps" (timeout + delete guard); the duplicate
  `inflight`/`reconcile` is now a deliberate design choice, not an oversight.
- Toolset **agent-side** findings (capture leak, materialize budget, sequential
  pulls, login-shells, blocking `std::fs`) are unaffected by the queue — they
  live below the runtime seam.
- Non-blocking spawn dispatches `sandbox-create` unpooled but does **not** thread
  the job signal into boot/materialize, so C3 (multi-toolset budget) is
  unchanged.

---

## P0 — Security (fix before wider exposure)

### ☐ S1. Zip-bomb guard runs after extraction
`apps/server/src/runtime/registry/zip-context.ts:61-81`
`unpackZipContext` extracts the whole archive, then measures size. A nested
`deflate` bomb fills host disk before the 100 MB check runs. Reachable by any
authenticated user via `POST /v1/images/upload` (`v1.routes.ts:283`),
`t.File()` with no `maxSize`.
**Fix**
- Sum uncompressed sizes from `unzip -l` / `zipinfo` and reject **before**
  extracting.
- Add `t.File({ maxSize: … })` to the upload route to bound the raw body.
- Consider extracting under a size-capped location; keep the post-extraction
  `du` check as a backstop.

### ☐ S2. Zip symlink entries → arbitrary host file read
`apps/server/src/runtime/registry/zip-context.ts:45-53,98-108`
`assertSafeEntries` validates the path string but not the entry **type**.
`unzip` restores symlinks verbatim; a `Dockerfile` symlink → an absolute host
path is then followed by `readContextDockerfile`'s `stat` + `Bun.file().text()`,
persisted into `images.dockerfile` and served back via `GET /v1/images/:name`.
Arbitrary-file-read for any authenticated user (SA token, mounted secrets, …).
**Fix**
- After extraction, walk `contextDir` and reject/`rm` any entry where
  `lstat(...).isSymbolicLink()`. A Dockerfile+rootfs upload needs no symlinks.

### ☐ S3. No role gate on arbitrary Dockerfile builds
`apps/server/src/api/v1.routes.ts:261-322`
`/v1/images*` sits behind the generic `authPlugin`. With the default
`imageBuilder.kind=docker`, `docker.builder.ts` itself documents this as
root-equivalent RCE. Any authenticated user can submit a build.
**Fix**
- Gate the build/upload/register routes behind an operator/admin role
  (`control/` already has role concepts), at minimum for `kind=docker`.

---

## P1 — Correctness & convergence

### ☐ C1. Close the two image-build correctness gaps (feed bridge already landed)
`apps/server/src/runtime/registry/image-builder.service.ts:279` (`deleteImage`),
`:350` (unused `AbortController`); `docker.builder.ts` (no timeout)
`1652a6ee` bridged image builds into the job feed but deliberately kept
execution in `ImageBuilderService`, so two gaps remain:
- **No abort / no docker timeout.** The `AbortController` at `:350` is created
  and threaded through every backend but **never aborted**. The k8s builders
  self-bound with a 30 min `BUILD_TIMEOUT_MS`; the docker backend has none, so a
  hung `docker build`/`push` wedges the `inflight` dedupe entry until a full
  server restart. The `image-build` job is `track` (unpooled), so it is also
  **non-cancellable** through the queue.
- **`deleteImage` has no `building` guard.** Deleting mid-build orphans the
  eventual registry push, and the completion `store.update` silently no-ops on
  the now-missing row.
**Fix (minimal, matches the chosen bridge design)**
- Wire `AbortSignal.timeout(BUILD_TIMEOUT_MS)` into `executeBuild` (combine with
  the existing controller via `AbortSignal.any`) so the docker backend is
  bounded like the k8s ones. Add `signal.throwIfAborted()` before the push.
- Add a `status === "building"` guard to `deleteImage` (409), or store the
  controller and cancel-then-delete.
**Fix (optional, fuller convergence)**
- Switch the bridge from `track` to a pooled/cancellable `dispatch` and thread
  the job `signal` into `executeBuild`, so image builds gain real queue cancel
  and can drop `ImageBuilderService.inflight` + `reconcileOnStartup` (the queue
  owns dedupe-by-run and the reboot sweep). Only worth it if cancellable image
  builds are wanted.

### ☐ C2. `capture()` staging debris leaks into the live home
`apps/agent-v2/src/toolset.rs:172,414-451`
`squash_and_push_script` (shared by `build` + `capture`) stages into `mktemp`
dirs directly under `/home/dev`. The "pod/PVC torn down right after, so a failed
ESTALE `rm` is harmless" rationale is **true for `build()`** (throwaway pod) and
**false for `capture()`** (live sandbox, not torn down). A failed EXIT-trap
`rm` leaves `atelier-toolset-stage.<rand>/` (a full uncompressed copy of the
captured paths) visible in `~`, never swept, riding every future pause snapshot
and prebuild clone.
**Fix**
- Stage under a dot-prefixed, well-known scratch dir that `build`/`capture`
  sweep at **start** (mirror the `atelier-toolset-pull.*` sweep at
  `toolset.rs:695-716`).
- Correct the comment so it stops claiming universal teardown safety.

### ☐ C3. Multi-toolset boot budget is inconsistent across three layers
`apps/agent-v2/src/toolset.rs:721-793` (per-toolset fresh 600 s each) vs
`apps/server/src/runtime/agent/agent.client.ts:424`
(`materializeToolsets` — single 600 s for the whole call) vs
`.../seeds/dev-base/rootfs/etc/sandbox/sandbox-boot.sh:77` (600 s total wait).
With N>1 toolsets on a cold boot (org + user + selected, composed in
`v1.routes.ts`), the agent loop can take up to N×600 s while the runtime HTTP
client aborts at 600 s (hard `AgentUnavailableError` failing create/resume even
though the pod would finish) and the entrypoint starts sshd on a
partially-assembled home — reintroducing the race the redesign closed.
**Fix (preferred)**
- Make the 600 s a **global** deadline passed into the materialize loop; stop
  pulling once exhausted and fail fast ("N of M toolsets pulled").
**Fix (alt)**
- Scale all three ceilings by toolset count (`base + perToolset × count`),
  passing the count to `agent.client` and the entrypoint.

---

## P2 — Performance

### ☐ P2a. Pull toolset blobs concurrently
`apps/agent-v2/src/toolset.rs:721-793`
Independent `oras pull`s are awaited sequentially; boot latency scales linearly
with toolset count — the exact cost the redesign removed for *file* count,
reintroduced for *toolset* count.
**Fix** Pull concurrently with a small cap (background jobs + `wait`, or bounded
`tokio` fan-out), then mount + assemble sequentially. Also shrinks C3's window.

### ☐ P2b. Single registry HEAD in `resolveImage`
`apps/server/src/runtime/runtime.service.ts:1263-1272`,
`apps/server/src/runtime/registry/image-registry.service.ts`
For an image without a `ready` row, spawn does `imageExists` (HEAD) then
`resolveImageReference` (near-identical HEAD reading `docker-content-digest`) —
double latency on the create hot path. (The `ready`-row fast path already
short-circuits both.)
**Fix** Merge into one HEAD returning `{ ref } | { missing } | { unreachable }`;
have `assertImageAvailable` and `resolveImage` share it.

### ☐ P2c. Non-login shells for root-run materialize plumbing
`apps/agent-v2/src/toolset.rs:701,784,854,884` via `command.rs:60-72`
`materialize_inner` spawns 3+N `/bin/bash -l -c` procs, each sourcing
`/etc/profile` + all `profile.d/*.sh` for pure root `mkdir`/`mount`/`find`/`rm`.
`readiness.rs:80-86` already set the non-login precedent.
**Fix** Add a `login: bool` to `command::run`; use non-login for the four
root-run scripts. Optionally merge cleanup/overlay/sweep into fewer invocations
(pairs well with P2a's concurrency rewrite).

### ☐ P2d. Non-blocking fs in async agent paths
`apps/agent-v2/src/toolset.rs:918,931,945-946,968,971-987`
`persist_materialize_request`/`self_heal_home` use blocking
`std::fs::{write,rename,read}` + `Path::exists` on tokio workers — on virtio-fs,
the one fs this design flags as stall-prone.
**Fix** Swap to `tokio::fs` (or `spawn_blocking` to keep atomic-rename
semantics). Low frequency, cheap fix, removes a tail-latency source.

### ☐ P2e. `stageContextTarball` copies the whole context to overwrite one file
`apps/server/src/runtime/registry/builder/k8s-build-job.ts:81-107`
Cheap for KB-sized seeds; doubles disk I/O for a 100 MB BYO upload.
**Fix** `tar --exclude=Dockerfile` from `contextDir`, then append the rewritten
Dockerfile — avoid the full-tree `cp`.

### ☐ P2f. `DrizzleImageStore.update` does 2 SELECT + 1 UPDATE per call
`apps/server/src/runtime/store.ts:535-544`
Runs every 1 s during a build's log flush.
**Fix** Direct `UPDATE … WHERE name = ?` (skip the `get`→`put` existence dance).

---

## P3 — Hygiene, dedup, best-practice

### ☐ H1. BuildKit `sh -c` shell-injection landmine
`apps/server/src/runtime/registry/builder/buildkit.builder.ts:76-90,138-140`
`buildctl ${args.join(" ")}` interpolates unescaped `build-arg:${k}=${v}` into a
shell string. Unreachable today (no caller sets `buildArgs`), but the port
advertises the field, kaniko/docker treat it as argv, and buildkit is the
backend wired into the live v2 deploy.
**Fix** Run `buildctl` as argv, or `shQuote` every interpolated value. Do this
alongside H2.

### ☐ H2. Deduplicate `buildArgs` argv formatting
`docker.builder.ts:76-78`, `kaniko.builder.ts:69-71`, `buildkit.builder.ts:138-140`
Same loop three times, differing only in flag shape.
**Fix** `formatBuildArgs(buildArgs, (k,v)=>…)` helper; single place to apply
H1's quoting.

### ☐ H3. `docker inspect` trusts `RepoDigests[0]` unfiltered
`apps/server/src/runtime/registry/builder/docker.builder.ts:116-133`
Could pin a foreign-repo digest if the same content was pushed elsewhere on the
daemon.
**Fix** Filter `RepoDigests` for the entry matching `req.tag`'s repo prefix
before taking the digest.

### ☐ H4. Dead `sandbox_toolset_refs.digest` + `getForSandbox`
`apps/server/src/runtime/store.ts:144`, `db/schema.ts:144-153`
Self-documented as unused across three store impls; `resume()` re-derives from
`spec`.
**Fix** Either wire `getForSandbox` into `resume()` (makes resume
spec-drift-proof — the design's original intent) or delete the column +
accessor. Prefer deletion unless drift-proofing is wanted now.

### ☐ H5. Duplicated `chown 1000:1000` / `/data/{upper,work,toolsets}` literals
`.../sandbox-boot.sh:22,31` vs `apps/agent-v2/src/toolset.rs:838,841`
Two independently-deployed artifacts that must agree, no compile/test link.
**Fix** Bake uid/gid + data-subdir layout into a pod env var
(`kube.resources.ts`) read by both. Low priority — do it if either surface is
touched again.

### ☐ H6. Validate seed manifests at load
`apps/server/src/runtime/registry/seeds/index.ts`,
`image-builder.service.ts` (`buildSeed`)
No `substitutions[].seed ⊆ dependsOn` check and no cycle detection; a drifted
`image.json` only fails at build time.
**Fix** Validate the subset + acyclicity in `readSeed`/`loadSeeds` so a broken
seed fails at server boot.

### ☐ H7. Reconcile the two context-size limits
`zip-context.ts:22` (100 MB) vs `builder/k8s-build-job.ts:44` (~900 KB encoded)
A 100 MB upload is accepted (`202`) then rejected async by kaniko/buildkit.
**Fix** Have the upload/`buildDockerfile` path check the active builder's real
ceiling up front and reject synchronously.

### ☐ H8. `spec.toolsets` uniqueness
`packages/spec/src/sandbox-spec.ts:211`
Dedup enforced in server + agent, nowhere at the schema.
**Fix** Service-level uniqueness check in `create`/`resume` for a clean 400
(TypeBox lacks `uniqueItems`).

### ☐ H9. Structured materialize error categories
`apps/agent-v2/src/toolset.rs:790-796`
Network vs corrupt-blob vs mount failure are indistinguishable to the runtime.
**Fix** (optional) Prefix the error (`registry:`/`format:`/`mount:`) for
retry/alert policy.

### ☐ H10. Tests for the security-sensitive surfaces
No coverage for `ImageBuilderService` policy (dedupe, digest pinning,
`deleteImage` guard, `rewriteSeedDockerfile`) or `zip-context.ts` guards
(traversal/symlink/oversize). Given S1/S2, add direct regression tests.

---

## New notes from the job-queue review (low)

### ☐ J1. Cancel of a deduped build "lies"
`runtime.service.ts:167` (prebuild), same shape for `buildToolset`.
A second job that dedupes onto an existing `inflight` run returns the first
run's promise and ignores its own `signal`; cancelling it aborts a signal
nothing observes, so its job row stays `running` until the shared run finishes,
then settles `succeeded`. Acknowledged by the code comment.
**Fix** (optional) Reflect deduped-onto state in the job (e.g. settle it to
mirror the primary run's terminal state, or surface "deduped" so cancel is a
no-op with honest UI).

### ☐ J2. `track` controllers are never aborted
`jobs.service.ts` (`track`) creates an `AbortController` whose signal is passed
to lifecycle ops, but tracked jobs are non-cancellable and nothing aborts it
(not even on shutdown). Mostly harmless; the signal is effectively dead for
tracked ops. Leave as-is unless a shutdown-drain is added later.

### ☐ J3. Image-build feed job and the image record can disagree on lifecycle
`apps/server/src/api/container.ts:116-127`
The `image-build` `track` job awaits `done` and `.catch(() => {})`s track's
re-throw. The job mirrors the build outcome, but is created **per build start**
(`onBuildStarted` fires in both `buildSeed` and `buildDockerfile`), while the
image record is dedupe-keyed by name. A rebuild of the same name creates a
second feed job for one logical image; and because the job is `track`, a hung
build leaves the job `running` forever (no timeout — same root as C1). Resolving
C1's timeout fixes the hang; the per-start duplication is cosmetic (feed shows
N rows for N rebuilds), acceptable as-is.

---

## Confirmed solid (no action)

- Overlay/blob correctness core: prior `fable5-review` fixes all present
  (`chown` upper-only, `SYS_ADMIN` + loop mknods, `self_heal_home`, ready/failed
  handshake, staging off rootfs, pull-scratch sweep, lowerdir dedup, slash-
  exclude rejection).
- Shell quoting: user-controlled strings go through `sh_quote` (Rust) /
  `shellQuote` (TS); no unquoted interpolation found (except the latent H1).
- No production `unwrap`/`panic` in the agent toolset paths.
- Job queue: first-terminal-state-wins settle, FIFO pump, reboot sweep, SSE
  replay-of-non-terminal — all sound. Cooperative cancel genuinely threads
  `signal` → runtime steps → agent client (combined with per-request timeout).
  Log ring buffer is now true LRU-by-write (fixed in `aa816b89`); spawn 202
  404-retry race fixed there too.
- Image-into-queue bridge (`onBuildStarted` → `track`) keeps `ImageBuilderService`
  free of any jobs-layer dependency — clean seam; the only gaps are the
  pre-existing C1 correctness items, not the bridge itself.
- Exec-as-dev default and toolset injection ordering (org → user → selected →
  spec, later-wins overlay priority) verified end-to-end.

---

## Suggested sequencing

1. **P0 batch** (S1, S2, S3) — smallest, highest-risk-reduction; add H10 tests
   alongside S1/S2.
2. **C1** — close the two image gaps: `BUILD_TIMEOUT_MS` in `executeBuild` +
   `building` guard in `deleteImage` (the feed bridge already landed). Bundle
   H1+H2 (buildkit quoting/dedup) since you're in the builders.
3. **C2, C3, P2a** — the toolset agent-side batch (capture leak, global budget,
   concurrent pulls); P2c/P2d ride along in `toolset.rs`.
4. **P2b, P2e, P2f + remaining H*** — incremental cleanup.
