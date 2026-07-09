# apps/server (v2) Audit

Full-module audit of `apps/server/src` (runtime / control / sessions / api).
Focus areas: simplification & deduplication, performance, sandbox boot-time
(prebuilt + 2-3 toolboxes), latent bugs, and sandbox lifecycle risks.

---

## 1. Latent bugs (most important first)

### B1. `/v1/sandboxes/:id/attach/:name` WS appears unauthenticated
`api/v1.routes.ts` — the attach WS has no user check inside `open()`. The
terminal WS (`api/sessions.routes.ts`) defensively checks `ws.data.user` and
closes `4001` when missing — implying the auth plugin's `resolve` does not
reliably guard WS upgrades in Elysia. The attach route grants **rw** stdio
access to any process (including the primary agent) with no such check.
Verify and mirror the terminal route's guard.

### B2. `addPort()` never updates the Service → live-added ports 404
`runtime/runtime.service.ts` (`addPort`) creates the Ingress and patches the
spec, but the Service was built at boot from the boot-time `spec.ports`
(`kube.resources.ts` `buildSandboxService` — the comment there explains
exactly why a missing Service port means "Traefik has no backend, 404"). A
port added live gets an Ingress pointing at a Service port that doesn't
exist. It only self-heals after a pause/resume rebuild. Needs a Service patch
in `addPort`.

### B3. Resume duplicates git-attribution files unboundedly
`api/v1.routes.ts` (resume route) appends fresh `gitFiles` to `body.files` on
every resume; `mergeResume` (`runtime.service.ts`) appends those onto
`spec.files`, and `resume()` **persists** the merged spec. Every pause/resume
cycle grows `spec.files` with another `/etc/gitconfig` + credentials pair.
Same-path entries should replace, not append (path-keyed merge, like
`mergeByName`).

### B4. `destroy()` deletes the record even when cleanup failed
`runtime/cleanup.ts` swallows every error and `destroy()`
(`runtime.service.ts`) then unconditionally `sandboxes.delete(id)`. A
transient K8s API failure leaks a running pod + PVC with **no record left to
retry from**. Ditto `deleteLabeledResources`'s per-collection `catch {}`
(`kube.client.ts`) — the comment claims it's for the missing-CRD case, but it
also hides real delete failures. At minimum: re-throw/flag on failure and
keep the record in an `error`/`deleting` state.

### B5. Agent 4xx errors surface as 503 `AGENT_UNAVAILABLE`
`runtime/agent/agent.client.ts` (`request`) — every non-OK agent response (a
`deny_unknown_fields` config rejection, a capture secret-scan finding, a bad
process name) is wrapped in `AgentUnavailableError` (503). The detail text is
preserved but the status/code is wrong; clients can't distinguish "retry
later" from "your request is invalid".

### B6. CLIProxy fetch has no timeout — can hang every spawn
`control/modules/cliproxy/cliproxy.service.ts` (`fetchModelIds`) fetches with
no `AbortSignal.timeout`. `enrichSpec` runs on every `POST /v1/sandboxes`; a
black-holed cliproxy endpoint stalls all spawns indefinitely. Add a 2-3s
timeout (the class already treats failure as soft-null).

### B7. Kubeconfig parsing picks the first `server:` in the file
`kube.client.ts` (`extractYamlValue`) regex-matches the *first* occurrence. A
multi-cluster/multi-context kubeconfig silently talks to the wrong cluster.
Also `token`/cert extraction has the same problem. Fine for single-cluster
k3s; a landmine otherwise.

### B8. Network-level fetch failures skip the retry loop
`kube.client.ts` (`request`) retries only on HTTP 429/5xx. A thrown fetch
(ECONNRESET, transient DNS) propagates immediately with zero retries — the
case retries help most.

### B9. Destroy orphans snapshot-store rows
`destroy()` deletes labeled VolumeSnapshots (pause/manual snapshots carry
`atelier.dev/sandbox=id`) but never deletes the corresponding `snapshots`
rows. The store accumulates records whose k8s objects are gone;
`resolveSource` against one would boot from a dangling ref.

### B10. Capture collision in `DrizzleToolsetStore`
`captureToolset` uses `hash = digest` (`runtime.service.ts`); two captures of
identical content under **different names** produce the same digest → `put`
upserts by hash and the second capture silently overwrites the first record
(whose `ref` may still be pinned by a toolbox version).

---

## 2. Sandbox lifecycle issues

### L1. `resume()` is fully broken (known, documented)
AGENTS.md already tracks it: `pause()` never persists the snapshot ref,
`resume()` re-resolves the *original* `spec.source` (so it doesn't even boot
from the pause snapshot — losing all disk state semantics) **and**
`bootSandbox` unconditionally creates `sandbox-${id}` PVC which pause left
behind → every resume 409s. This is the #1 lifecycle fix: persist
`pauseSnapshotRef` on the record, resolve resume's source from it, and either
reuse the PVC or delete-then-clone.

### L2. No state guards or per-sandbox mutual exclusion
`pause()`, `resume()`, `destroy()`, `snapshot()` never check `record.status`
and nothing serializes concurrent ops. Examples: `pause()` on a paused
sandbox creates a junk snapshot; `destroy()` racing an in-flight `create()`
lets the create's later steps (putConfig, hooks) recreate/dial resources
after cleanup; double `resume()` races two boots on the same pod name. A
tiny per-id async mutex + status precondition checks would close a whole
class of races.

### L3. Pause snapshot is crash-consistent, not clean
`pause()` snapshots the PVC *while processes are still running*
(`runtime.service.ts` — snapshot first, delete pod after). Databases/sqlite
files inside the sandbox may snapshot mid-write. Consider
`processStop`/sync (or at least agent-side `sync`) before `snapshotPvc`.

### L4. Crash recovery doesn't exist
Records persist in sqlite (`creating`, `running`), but on server restart
there's no reconciliation sweep: a sandbox stuck in `creating` (server died
mid-boot) is never cleaned or resumed; a `running` record whose pod was
OOM-killed stays "running" forever. AGENTS.md notes event/cron ports are
deferred, but a cheap startup sweep (list pods by label, diff against store)
would prevent zombie records.

### L5. `create()` failure leaves `status: "error"` records with no recovery route
No retry/destroy semantics distinguish them; `resume()` on an `error` record
will happily try to boot.

---

## 3. Sandbox boot-time speedup (prebuilt + 2-3 toolboxes)

Hot path: `POST /v1/sandboxes` → toolbox resolution → `bootSandbox` →
materialize → config/files → hooks → primary gate.

### S1. Toolbox resolution is fully serial
`api/container.ts` (`resolveToolboxRefs`, `resolveSelectedToolboxes`): each
toolbox does pinned-version lookups, and on cache miss a **whole throwaway
pod build, one at a time**. Even on the hit path it's sequential awaits.
Parallelize with `Promise.all` per owner tier — cold-build worst case goes
from N×(pod boot + build) to max().

### S2. Overlap `putConfig` with `materializeToolsets`
`runtime/boot.ts`. Materialize must precede `writeFiles` (last-wins
layering), but config push is independent.
`Promise.all([materializeToolsets, putConfig])` then `writeFiles` shaves an
agent round-trip plus lets the agent parse config while extracting.

### S3. Toolset materialization is the dominant post-schedule cost
2-3 `oras pull` + tar-extracts serially in-guest. Two levers:
(a) send refs in one request (already done) but have agent-v2 pull in
parallel; (b) the deferred "rung-1 baked-pair cache" from the proposal
(snapshot of prebuild ⊕ toolset set, keyed by both hashes) removes the
extraction from boot entirely for repeat combos — that's the big structural
win for the prebuilt + 2-3 toolbox use case.

### S4. `waitForAgent` polls K8s GET + health every 200ms
`agent.client.ts`. Fine for latency, but consider a K8s watch on the pod
(single connection, instant IP) — also cuts API-server load with many
concurrent boots.

### S5. PVC create is serialized before the pod/service/pipe batch
`boot.ts`. One extra API call (~tens of ms); could join the same
`Promise.all` if ordering with WaitForFirstConsumer is confirmed safe. Low
priority.

### S6. Spawn-from-prebuild pays `ls-remote` per repo every time
`resolveContentKey` → `resolveRepoHeads`, up to 5s/repo on the spawn request
path. A short TTL cache (30-60s) on repo HEADs would remove the biggest
variance on the request path (keep the cron uncached).

---

## 4. Simplification / deduplication

### D1. Dead code — safe deletes
- `shared/lib/retry.ts`, `shared/lib/shell.ts`, `shared/lib/phase-timer.ts`
  — zero imports anywhere.
- `AgentClient.batchExec` — unused.
- `KubeClient`: `listJobs`, `getJobStatus`, `waitForJobComplete`,
  `restartDeployment`, `listPodMetrics`, `listPvcs`, `getPodLogs`,
  `getPodStatus`, `checkRuntimeClass`, `checkSnapshotApi`,
  `checkVolumeSnapshotClass`, `checkApiHealth`, `listPods`, `getPod` — all
  unused (~250 lines, a third of the file).
- `resolveImage`'s `"snapshot" in source` branch (`runtime.service.ts`) is
  unreachable — `resolveSource` handles snapshots before calling it.

### D2. `resolveToolboxRefs` / `resolveSelectedToolboxes` are ~80% identical
`api/container.ts`: pinned-version fast path, build,
`recordBuiltVersionLazily`, log-and-skip. Extract one
`resolveToolboxToRef(container, owner, config)` and both collapse to loops.

### D3. `FileWrite` owner-cast mapping is copy-pasted 3×
`boot.ts`, `runtime.service.ts` `patchFiles` and `executePrebuild`. One
`toFileWrites(files)` helper.

### D4. Two near-identical WS byte relays
`v1.routes.ts` attach and `sessions.routes.ts` terminal (open/message/close +
upstream stash). A shared `createWsRelay(upstreamUrl)` helper kills ~60
duplicated lines (and would carry the B1 auth fix to both).

### D5. `executePrebuild` / `executeToolsetBuild` share the same skeleton
Boot-throwaway-pod → steps → publish → cleanup-in-finally. A
`withThrowawayPod(tempId, spec, fn)` wrapper deduplicates the
boot/cleanup/invalidate tail.

### D6. Pinned-version lookup + dangling-pin warning appears twice
`api/container.ts` — folds into D2.

### D7. `cleanupSandboxResources`'s `podName` param is redundant
The label sweep already deletes the pod (it carries
`atelier.dev/sandbox=<id>`); the explicit follow-up delete is a second delete
of the same object.

---

## 5. Performance (non-boot)

### P1. Secret crypto re-derives the AES key on every encrypt/decrypt
`control/modules/secret/crypto.ts` — SHA-256 + importKey per call. Cache the
`Promise<CryptoKey>` module-level.

### P2. `deleteLabeledResources` is serial across 8 collections × N items
`kube.client.ts`. Destroy/pause latency = sum of all list+delete calls.
`Promise.all` the collections (and items) — destroy drops from ~1-2s to
~200ms.

### P3. `SessionService.surfaceFor` costs an agent round-trip per request
It calls `runtime.get()` **only to read one annotation**, but `runtime.get()`
always round-trips the agent for `processList`. Every `/sessions/*` request
pays a processList it throws away. Read the annotation from the store record
instead (e.g. a cheap `runtime.getRecordAnnotations(id)`).

### P4. DrizzleStore `update()` = SELECT + full-row UPDATE
Fine at this scale; not worth changing yet.

### P5. `refreshStalePrebuilds` is serial per snapshot
Up-to-5s ls-remote per repo — protected cron so it's safe, just slow;
parallelize if the list grows.

---

## Suggested priority

1. **B1** (attach auth) — security.
2. **L1 + L2** (resume contract + lifecycle mutex/status guards) — resume is
   a headline feature and currently 100% broken.
3. **B2, B3, B6** (addPort service patch, resume file growth, cliproxy
   timeout) — small fixes, real user impact.
4. **S1 + S2** (parallel toolbox builds, overlap config/materialize) — cheap
   boot wins; **S3's baked-pair cache** is the structural win for the
   prebuilt + toolbox use case.
5. **D1** (dead code, ~400 lines) — free.
