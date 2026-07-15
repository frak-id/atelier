# Portable Runtime Backends — Implementation Log

Live record of executing steps 1–4 of
[`portable-runtime-backends.md`](./portable-runtime-backends.md): the
`SandboxBackend`/`VolumeBackend` extraction, the pluggable `SshGateway`,
dual-format prebuild artifacts, and the `Tar` blob rung in `agent-v2`.

This file tracks **decisions, short-circuits, oracle consultations, and
plan-compliance notes** as they happen. Newest entries at the bottom of each
step. Commits are gradual and referenced here.

---

## Conventions

- **DECISION** — a design choice made and why.
- **SHORT-CIRCUIT** — a deliberate scope cut / deferral vs. the proposal, with
  rationale, so it is auditable later.
- **ORACLE** — a consultation, the question, and the resolution taken.
- **PLAN-COMPLIANCE** — how the delivered change maps back to the proposal's
  step description.

---

## Step 1 — Extract `SandboxBackend` + `VolumeBackend`

**Proposal target:** behavior-preserving refactor; current code becomes
`KubernetesBackend`/`CsiVolumeBackend`; move `urlsFor` URL-shaping, `addPort`,
and `getPodIp` behind the port; scope the isMock folding to ONLY the
sandbox/volume branches (leave git-`ls-remote` + registry-HTTP mock paths).

### Surface inventory (verified by reading `runtime.service.ts` in full + scout map)

Direct `kubeClient.*` / boot / URL calls in `runtime.service.ts` that must move
behind the port:

| Site | Call | Destination |
|---|---|---|
| `removeSnapshot` | `kubeClient.deleteResource("VolumeSnapshot", ref)` (isMock-guarded) | `VolumeBackend.deleteSnapshot` |
| `resume` | `kubeClient.resourceExists("PersistentVolumeClaim", …)` (isMock-guarded) | `VolumeBackend.volumeExists` |
| `snapshotPvc` | `resourceExists` + `deleteResource` + `waitForResourceDeleted` + `createResource(buildVolumeSnapshot)` + `waitForVolumeSnapshotReady` | `VolumeBackend.snapshot` |
| `reconcileOnStartup` | `kubeClient.resourceExists("Pod", …)` | `SandboxBackend.computeExists` |
| `addPort` | `kubeClient.patchResource("Service", …)` + `createResource(buildPortIngresses(...))` | `SandboxBackend.exposePort` |
| `urlsFor` | `buildPortUrls` + `sshUrl` (URL shaping) | `SandboxBackend.urls` (raw), readiness overlay stays |
| `create`/`resume`/prebuild/toolset | `bootSandbox(...)` | `SandboxBackend.boot` |
| `pause`/`resume` | `deleteRestartableResources(...)` | `SandboxBackend.deleteRestartable` |
| `create`(fail)/`destroy`/reconcile/throwaway | `cleanupSandboxResources(...)` | `SandboxBackend.cleanup` |
| (AgentClient) | `kube.getPodIp(...)` | `SandboxBackend.resolveAgentEndpoint` |

`isMock()` in `runtime.service.ts` (5 sites): 3 are sandbox/volume
(`removeSnapshot`, `resume` PVC check, `snapshotPvc`) → removed by routing
through the backend; 2 stay (`resolveRepoHeads` = git seam; `reconcileOnStartup`
early-return = reconcile seam). This matches the proposal's "leave git-ls-remote
alone" scoping exactly.

### DECISION — port shape

`SandboxBackend` (holds `.volumes: VolumeBackend`) with:
`boot`, `deleteRestartable`, `cleanup`, `computeExists`, `exposePort`,
`urls(id, spec) → {name,url}[]` (raw, no readiness), `resolveAgentEndpoint`.
`VolumeBackend` with: `snapshot`, `deleteSnapshot`, `volumeExists`.
`KubernetesBackend`/`CsiVolumeBackend` implement them by delegating to the
existing `boot.ts` / `cleanup.ts` / `ports.ts` / `kube/*` functions **verbatim**
— no logic rewrite, only relocation of the call sites out of `RuntimeService`.
Wired via `RuntimeDeps.backend` (default `new KubernetesBackend()`), so the seam
is injectable for future Docker/local backends and tests.

### SHORT-CIRCUIT — defer a standalone `MockBackend`

The proposal's step-1 line says "fold sandbox/volume isMock into a
`MockBackend`." **Deferring the standalone MockBackend to the step where
`boot.ts`/`cleanup.ts` themselves move fully behind the port.**

Rationale: `bootSandbox`/`cleanupSandboxResources`/`kubeClient.*` still carry
their own internal `isMock()` guards (they are shared by boot/cleanup/ssh-key/
AgentClient, none of which move in step 1). A MockBackend that only covers the
`RuntimeService`-direct calls while boot/cleanup stay mock-internally would be a
**half-migrated mock split** — strictly worse than either end state, and it
would risk diverging the mock-mode lifecycle the `runtime.lifecycle.test.ts`
contract pins. Instead: `KubernetesBackend`/`CsiVolumeBackend` wrap the existing
(already mock-safe) functions, and `RuntimeService` drops its 3 now-redundant
sandbox/volume `isMock()` guards. Net effect the proposal wanted — no direct
kubeClient in RuntimeService, sandbox/volume isMock gone from RuntimeService —
is achieved; the mock behavior simply still lives in the Kubernetes leaf until
that leaf is itself split. Verified mock-safe: `deleteLabeledResources`,
`resourceExists`, `waitForVolumeSnapshotReady`, `getPodIp` all no-op/return
their mock constants internally, so the default `KubernetesBackend` keeps the
test green in `ATELIER_SERVER_MODE=mock`.

### ORACLE — step-1 boundary review (run c47e7292)

Consulted the oracle on the port shape + the MockBackend deferral before
writing code. Artifact: `.pi-subagents/artifacts/c47e7292_oracle_0_output.md`.
Verdict: boundary mostly sound; MockBackend deferral **correct**; three
adjustments accepted:

1. **Drop `resolveAgentEndpoint` from the step-1 port entirely.** RuntimeService
   never calls `getPodIp`; only `AgentClient.resolvePodIp` (private) does, plus
   `sessions/` URL builders that hold an `AgentClient`, not a backend. Adding
   the method now means guessing its Docker-era shape (`{host}` vs
   `{host,agentPort,attachPort}`, who owns `ws://`/`http://` scheme + the IP
   cache) — exactly the §4.4 attach-reachability subtlety. **Leave
   `AgentClient.kube`/`getPodIp` untouched**; add a `TODO(docker)` marker at
   `resolvePodIp`; design `resolveAgentEndpoint` against the real second impl in
   the Docker step.
2. **`backend.urls()` returns the FULL set including the `{name:"ssh"}` entry**
   (wrap `buildPortUrls` + `sshUrl`). Leaving `sshUrl` in RuntimeService would
   re-introduce a `ports.ts` import that step 2 has to claw back; folding it in
   makes step 2 a pure backend/gateway change with no RuntimeService edit. The
   readiness overlay (`gatingProcessNames` + live correlation) STAYS in
   RuntimeService (backend-neutral policy); ssh naturally matches no gating
   process.
3. **`snapshot()` stays `Promise<void>` for step 1** (verbatim) but is expected
   to grow a return value (a produced ref/locator) in step 3 for OCI-tar; do
   not over-fit to `void`.

Other confirmations: keep `snapshotPvc`'s `resourceExists→delete→wait→create→wait`
sequence as ONE verbatim method body in `CsiVolumeBackend.snapshot` (highest
regression risk if decomposed); `AgentClient.invalidatePodIp` calls stay in
RuntimeService (cache hygiene, not backend); `bootSandbox` already self-cleans
on failure so don't double-wrap `boot()`; drop the 3 isMock guards by routing
through the backend (no residual `!isMock() &&`), ending with exactly **2**
isMock in runtime.service.ts.

### DECISION — finalized step-1 port (post-oracle)

```ts
interface VolumeBackend {
  snapshot(pvcName, ref, labels, annotations?): Promise<void>; // step-3: grows a ref return
  deleteSnapshot(ref): Promise<void>;
  volumeExists(pvcName): Promise<boolean>;
}
interface SandboxBackend {
  readonly volumes: VolumeBackend;
  boot(id, spec, input, agent): Promise<BootOutput>;
  deleteRestartable(id): Promise<void>;
  cleanup(id): Promise<boolean>;
  computeExists(id): Promise<boolean>;      // Pod resourceExists
  exposePort(id, port): Promise<void>;
  urls(id, spec): { name; url }[];          // incl. ssh entry
  // resolveAgentEndpoint OMITTED in step 1 (Docker step).
}
```

### PLAN-COMPLIANCE note

Proposal step 1 lists moving "`urlsFor` URL-shaping, `addPort`, and `getPodIp`".
Delivered: URL-shaping → `urls()`; `addPort` k8s body → `exposePort()`;
**`getPodIp` deferred** (oracle Q2) with a TODO marker — the one intentional
deviation from the step-1 line, justified above. MockBackend also deferred
(documented short-circuit). Net proposal intent — no direct `kubeClient` in
RuntimeService, sandbox/volume isMock gone from RuntimeService, injectable seam
for Docker/local — is fully met.

### Implementation approach

Implemented by the parent (sole writer) since it is a delicate behavior-
preserving refactor of a file read in full, then audited by a fresh-context
reviewer agent against this contract. Gradual commit at step end.

### Review (reviewer run 84ca829e) + resolution

Fresh-context reviewer audited the staged diff against the 8-point contract.
Result: all 8 verified correct (routing, mock equivalence, exactly 2 isMock / 0
kubeClient, snapshot sequence + timeouts, exposePort verbatim, computeExists
equivalence, no boundary imports, barrel exports) except one narrow finding:

**ACCEPTED RISK — `urlsFor` + a public port named `"ssh"`.** Old code appended
the ssh connection entry *after* the readiness `.map()`, so it was never
overlaid. New code overlays the combined `backend.urls()` list. Divergence
exists ONLY if a spec declares a public port literally named `"ssh"` — then the
connection entry would gain bogus `processes`/`ready` fields. Decision: **accept
and document, do not fix in code.** Rationale: (1) for every realistic spec the
behavior is byte-identical; (2) the ambiguity is pre-existing — a port named
`"ssh"` already emitted two `"ssh"` URLs before this refactor, so it was already
broken; (3) the alternatives (URL-scheme sniffing, a `kind` discriminator on
`SandboxUrl`, or reserving `"ssh"` in `PortSchema`) all add complexity/validation
the task does not warrant (scope discipline). Marked with an explicit code
comment at `urlsFor` noting the unenforced assumption. Verified: `tsgo`
typecheck, boundary check, and all 36 server tests (incl. 14 lifecycle) green.

---

## Step 2 — Pluggable `SshGateway` (sshpiper becomes optional)

**Proposal target:** extract the `Pipe` + ssh-pipe-key emission behind a
`sshpiper` strategy, add a `none` strategy, land the in-server `ssh2` proxy
(new default), host key in the control DB secrets store, config `ssh.gateway`.

### SSH model (verified in code)

- The sandbox **pod** trusts exactly one key: the shared ed25519 **public** key,
  mounted from a Secret at `/etc/sandbox/ssh/authorized_keys`
  (`kube.resources.ts` `buildSandboxPod` → `sshPipeKeySecret`). So only whoever
  holds the shared **private** key can log into the pod as `dev`.
- **sshpiper** holds the shared private key (`to.private_key_secret`) and dials
  `pod:22` as `dev`; it authenticates the *client* against the dev's own public
  keys carried per-sandbox in the `Pipe`'s `from.authorized_keys_data`
  (`buildSshPipe`).
- Consequence for strategies: `sshpiper` and a future `in-server` proxy both
  keep the **pod side identical** (pod trusts the shared key; the proxy does the
  hop). `none` has no proxy holding the shared key, so for a port-forwarding
  operator to authenticate the pod must instead trust the **dev's own keys**.

### DECISION — the three strategies' boot-side wiring

| Strategy | Pod `authorized_keys` source | Pipe? | Shared key? |
|---|---|---|---|
| `sshpiper` (default) | shared-key Secret (today) | yes | ensured |
| `none` | a per-sandbox Secret holding the **dev's** keys | no | not needed |
| `in-server` (deferred) | shared-key Secret (proxy hops) | no | ensured |

`none` mounts the dev's `authorizedKeys` (already an explicit boot input) into
the pod via a per-sandbox Secret at the same mount path, so `kubectl
port-forward` + direct SSH works for an operator — matching the proposal's
`none` description. When the sandbox has no authorized keys, `none` mounts
nothing (SSH simply off).

### SHORT-CIRCUIT — defer the in-server `ssh2` *listener*

The proposal's step 2 says "land the in-server ssh2 proxy." **The boot-side seam
and config land now; the actual listening ssh2 proxy process is deferred to its
own spike.** Rationale (reality before dream):

1. **Unvalidatable here.** The proxy's whole risk is faithful channel
   forwarding (`session`/pty, `sftp`, `direct-tcpip`) for git-over-ssh + VS
   Code/Cursor/JetBrains Remote-SSH. That can only be verified against a live
   pod `sshd` — impossible in mock/CI without a cluster. Shipping unvalidated
   SSH-forwarding networking, even opt-in, is exactly what the proposal itself
   flagged as a distinct "Remote-SSH channel-fidelity spike."
2. **Cross-boundary wiring.** The listener needs the persistent host key (control
   DB secrets store) + the shared private key + endpoint resolution + a
   long-running socket in the composition root (`apps/server/src/index.ts`).
   `runtime/` cannot import `control/`, so the listener belongs at the
   composition root, designed against the real host-key + auth-registry
   surface — not stubbed blind now.
3. **The seam makes it a drop-in.** `ssh.gateway: "in-server"` + an
   `InServerSshGateway` (pod mounts the shared key, no Pipe — already expressible
   in this seam) + a listener module is the follow-up; nothing here blocks it.

So step-2 ships `sshpiper` (default, verbatim) + `none`, with the config enum
and boot seam ready for `in-server`. Default stays `sshpiper` (behavior-
preserving); the in-server proxy becomes default only after its live spike.
Host-key-in-control-DB is therefore also deferred (only the listener needs it).

### Review (reviewer run 002d0da7) + tests

Fresh-context reviewer: **default (`sshpiper`) path provably output-identical**
to pre-diff (byte-identical `buildSshPipe` args + `encodeAuthorizedKeys` matches
the deleted `encodeSshAuthorizedKeys`); `none` Secret is single-base64-encoded
(correct k8s convention, matches the shared-key secret shape) so the mounted
file gets raw keys; lifecycle safe (per-entry try/catch no-op for absent
secrets, pause deletes before resume recreates, `none` Secret labeled so
destroy's sweep reaches it); index.ts gating correct; boundary clean; no
dangling refs. No blockers. New unit tests (`ssh-gateway.test.ts`, 4 cases)
pin the per-strategy resource emission; full server suite 40/40 green;
typecheck + boundary clean.

### PLAN-COMPLIANCE note

Delivered: `SshGateway` seam + `sshpiper`/`none` strategies + `ssh.gateway`
config — sshpiper is now optional (the original ask). Deferred vs. the proposal:
the in-server `ssh2` **listener** and host-key-in-control-DB (documented
short-circuit above; seam ready). Boot stops emitting the `Pipe` for
`none`/`in-server`, which is the concrete "make sshpiper optional" change the
proposal §5 called for.

---

## Step 4 — `Tar` blob rung in agent-v2 (done before step 3)

**Proposal target:** add a `Tar` variant to `BlobFormat` + a capability probe /
copy fallback in `apps/agent-v2/src/toolset.rs`, so the agent no longer
hard-errors when the guest kernel can mount neither erofs nor squashfs — the
real portability enabler for locked-down/rootless (proposal §6-7).

**Reorder note:** delivered before step 3 because it is the concrete,
cargo-testable foundation (and the agent-side tar machinery a future OCI-tar
prebuild would reuse), whereas step 3's OCI-tar leaf is infra-gated.

### DECISION — Tar is extracted, not mounted

erofs/squashfs blobs are loop-mounted read-only and stacked as overlay
lowerdirs. A `Tar` blob (`<digest>.tzst`, zstd) is instead **extracted into a
plain directory** which is used directly as an overlay lowerdir (overlayfs
accepts ordinary dirs as lowers). So the Tar rung removes the loop-device +
read-only-FS-driver requirement while keeping the existing single-overlay
assembly. Changes:

- `BlobFormat::Tar` with `ext()="tzst"` (single token, so `<digest>.*` glob +
  `${blob##*.}` recovery are unchanged), `fs_type()=None` (not mounted),
  `media_type()=...tar+zstd`, `mkfs_cmd()=tar --zstd ... -cf <name> -C <stage> .`
  (uid/gid-1000 + epoch-mtime normalized, matching erofs/squashfs).
- `detect_build_format` no longer returns `Result`/hard-errors: it picks the
  first mountable format the kernel supports, **else `Tar`**. Extracted into a
  pure `select_build_format(is_supported)` for unit testing.
- Materialize discovers a `.tzst` blob (pull-layer glob + existing-blob glob
  already `*` / now list `*.tzst`), and its per-arm `case` **extracts** the
  tarball into the mount point (idempotent: only when the dir is empty) instead
  of `mount -t`. The stale-blob sweep glob gains `*.tzst`.

### SHORT-CIRCUIT — no-overlay tier not addressed

The Tar rung targets kernels that lack a mountable RO FS but **still have
overlayfs**. A fully locked-down environment without overlayfs at all would need
a direct copy-merge into the home (no overlay) — a different assembly model,
deferred. Also: `.tzst` extracts into the tmpfs mount point (`/run/toolsets`),
so a very large tar costs RAM; acceptable for a last-resort fallback, noted here
for when the copy-merge tier is designed.

### Verification

`cargo build` clean; `cargo test` 52/52 (incl. updated `blob_format_*`,
`mkfs_cmd_*`, `sweep_*`, and new `select_build_format_falls_back_to_tar_*`).
clippy clean for `toolset.rs` (the one repo warning is pre-existing in
`attach.rs`). CI does not gate Rust on fmt/clippy; the crate is hand-formatted
(HEAD already has 10 `cargo fmt` diffs) so new code matches that style rather
than reformatting pre-existing lines.

---

## Step 3 — Dual-format prebuild artifacts (seam + config; OCI-tar leaf deferred)

**Proposal target:** prebuilds materializable as CSI `VolumeSnapshot` **or** OCI
`tar.zst`, same content-hash key, `VolumeBackend` picking the fastest; config
`storage.provider`.

### Finding — the substance is infra-gated

The content-key (`resolveContentKey`) and the snapshot store are ALREADY
storage-agnostic (confirmed step-1 oracle). The only storage-specific pieces are
(a) snapshot creation (`CsiVolumeBackend.snapshot`) and (b) boot materialization
(`buildPvc` `dataSource` clone). "Dual-format" needs a SECOND implementation of
both — an OCI-tar producer (whole-`/data`-PVC tar + `oras push`, a new agent
operation that does not exist — the toolset build only tars selected home paths)
and an OCI-tar materializer (empty PVC + agent pull/extract at boot). Both need
a live cluster + registry to build and validate; neither is exercisable in
mock/CI.

### SHORT-CIRCUIT — ship the seam + config, defer the OCI-tar leaf

Building a persisted `format` column + boot-time clone-vs-extract dispatch while
only CSI exists would be **single-valued speculative abstraction** (against the
"no design for hypothetical requirements" guardrail) — and the OCI-tar leaf it
would serve can't be validated here anyway. So step 3 delivers the
non-speculative, immediately-real seam and defers the leaf (mirroring step 2's
in-server-listener deferral):

- **Config `storage.provider`** (`csi` default | `btrfs` | `reflink` | `copy`)
  — the proposal §8 config axis, documenting the degradation ladder.
- **`createVolumeBackend(provider)`** selects the storage plane; only `csi` is
  wired (returns `CsiVolumeBackend`), the rest **fail fast at construction**
  with a clear message rather than silently degrading. `KubernetesBackend.volumes`
  now goes through it.
- Deferred (documented): the OCI-tar producer + materializer (needs agent
  whole-PVC tar/extract + registry + cluster), the host-FS providers
  (btrfs/reflink/copy — land with the Docker/local backend), and the persisted
  per-snapshot `format` column + clone-vs-extract dispatch (added WITH the
  OCI-tar leaf, when there is a second value to distinguish). The oracle's
  suggested `snapshot()`→descriptor return is likewise deferred to that point,
  to avoid a one-format contract change that is pure ceremony today.

### Verification

New `kubernetes.backend.test.ts` pins provider selection (csi → CsiVolumeBackend;
btrfs/reflink/copy → fail fast). Full server suite 45/45; typecheck + boundary
clean; shared package typechecks with the new `storage` config.

### PLAN-COMPLIANCE note

Proposal step 3 = "dual-format prebuild/toolset artifacts." Delivered: the
`VolumeBackend` provider seam + `storage.provider` config surface. The dual
*format* itself (OCI-tar) is the honest deferral — infra-gated, not speculatively
stubbed. Step 4 (the agent `Tar` rung) already landed the tar/extract machinery
an OCI-tar prebuild would build on, so the follow-up has its foundation.

---

## Cross-step status

| Step | State | Commit |
|---|---|---|
| 1 — SandboxBackend/VolumeBackend extraction | done | `0a77e0ff` |
| 2 — pluggable SshGateway (sshpiper optional) | done (in-server listener deferred) | `242de191` |
| 4 — Tar blob rung in agent-v2 | done | `ae694560` |
| 3 — dual-format prebuild seam + config | done (OCI-tar leaf deferred) | _this commit_ |

**Deferred, infra-gated follow-ups** (each needs a live cluster/registry/guest to
build+validate, all with the seam ready): in-server ssh2 proxy listener +
host-key-in-control-DB; OCI-tar prebuild producer/materializer; host-FS volume
providers (btrfs/reflink/copy) with the Docker/local `SandboxBackend`; the
no-overlayfs copy-merge toolset tier; backend→UI progress events for Tier-2
stop-then-copy.

---

# Phase 2 — Docker backend (steps 5-6)

Docker became available locally (OrbStack, linux/aarch64 with `CAP_SYS_ADMIN` +
overlayfs), so the "dream" steps 5-6 moved from infra-gated to buildable. Done
in four commits after the phase-1 audit.

## Step 6a — `runtime.backend` selector seam (`1dbb07d6`)

Added `config.runtime.backend` (`kubernetes` default | `docker` | `local`) +
`createSandboxBackend(backend)` selecting the orchestrator, mirroring
`createVolumeBackend`. RuntimeService defaults its backend through it.

**SHORT-CIRCUIT:** deferred the proposal's invasive `kubernetes.*` → backend
sub-config nesting (25 `config.kubernetes.*` refs; purely cosmetic) — it buys
nothing until a second backend needs a *different* config tree, and would be
pure churn now. Documented for when it does.

## Endpoint seam — `resolveAgentEndpoint` (`4a05b385`) — the step-1 deferral, resolved

The step-1 oracle (Q2) deferred pulling endpoint resolution off `AgentClient`
until the real second backend existed. It now does. `SandboxBackend` grows
`resolveAgentEndpoint(id): AgentEndpoint | null` (`{host, agentPort,
attachPort, terminalPort}`); `AgentClient` takes an injected resolver (default =
the old kube pod-IP logic, so direct construction stays behavior-identical) and
owns all three URLs. `terminal.service` stopped reaching for `getPodIp` + a
manual `:7681` URL (which would have been wrong under Docker's mapped ports) and
calls `agent.terminalBridgeUrl`. Composition constructs the backend first, then
wires the agent to it. **DECISION:** endpoint carries *all three* mapped ports
because Docker publishes each container port on a distinct dynamic host port —
the `host:fixedPort` assumption the k8s code baked in is false off-cluster.

## Step 5 — `DockerBackend` + `LocalVolumeBackend` (`69d0b7f7`)

- **LocalVolumeBackend** (storage ladder's copy/CoW rung): `/data` is a host
  dir bind-mounted in; a snapshot is a CoW clone (`cp -c` APFS clonefile /
  `cp --reflink=auto` btrfs-XFS / plain-copy fallback). Same content-hash key as
  CSI — prebuilds stay addressable across planes. 6 real-FS tests (CoW clone
  verified on APFS).
- **DockerBackend**: `boot` = `docker run --privileged --user 0` (the Docker
  analogue of the pod's runAsUser 0 + `CAP_SYS_ADMIN`) with `/data` mounted,
  every infra+tool port published on a *dynamic loopback* host port, the sandbox
  image's `/etc/sandbox/sandbox-boot.sh` entrypoint (as k8s overrides it).
  `resolveAgentEndpoint` parses `docker port`; `computeExists` via `inspect`;
  `deleteRestartable` keeps the volume, `cleanup` removes it.
- **Shared boot tail** extracted to `boot-agent.ts` (`provisionAgent`) so both
  backends run wait→materialize→config→files identically (no drift).

### DECISION — validate orchestration against the *bare agent* image

The agent binds `:9998` and serves `/health` with no config, so the tiny
`FROM scratch` agent image (built in ~seconds) is enough to prove the
Docker-specific mechanics. The opt-in IT (`ATELIER_DOCKER_IT=1`) boots a real
container, confirms the mapped endpoint resolves, the agent is reachable at
`127.0.0.1:<mapped>` (real `waitForAgent`, not mocked), and cleanup tears it
down. Verified green on OrbStack. The IT is fully gated (flag + daemon + image
presence) and forces non-mock only inside that gate, so the normal mock suite
skips it with zero config-mode contamination.

### SHORT-CIRCUIT — full dev-base boot (materialize) not run here

A full `boot()` with real toolset materialization needs the `dev-base` sandbox
image — whose Dockerfile `COPY --from=zot.zot.svc:5000/sandbox-agent-v2` pulls
the agent from the *cluster-internal* zot registry, unreachable locally. So the
materialize/overlay tail (proven separately on k8s) is stubbed in the IT and the
full-image boot is the documented next validation, not a blind build. The bare
agent's `materialize([])` was empirically confirmed to fail on missing
`/home/skel` — i.e. the stub boundary is real, not hiding a bug.

### KNOWN LIMITATION — `exposePort` is a Docker no-op

Docker can't publish a new host port on a running container, so a *live-added*
public port (`exposePort`) logs a warning instead of failing silently; ports
declared in the spec are published at boot. A truly live public port needs a
container recreate — documented, deferred (the k8s path patches the Service +
Ingress live, which has no cheap Docker analogue).

### Still deferred after phase 2

same list as phase 1, plus: full dev-base Docker boot (registry-gated); Docker
`local`-process backend (Tier 3); live `exposePort` via recreate; the
`kubernetes.*` config sub-nesting.

## Phase 2 commit map

| Step | State | Commit |
|---|---|---|
| 6a — runtime.backend selector seam | done | `1dbb07d6` |
| endpoint seam (resolveAgentEndpoint) | done (resolves step-1 Q2 deferral) | `4a05b385` |
| 5 — DockerBackend + LocalVolumeBackend | done (orchestration validated; full dev-base boot deferred) | `69d0b7f7` |

Runtime backends now: `kubernetes` (full), `docker` (orchestration validated,
full-image boot registry-gated), `local` (reserved, fail-fast).

### Final audit (self, after a reviewer-agent glitch produced no output)

Per-step reviews ran on steps 1-2 (oracle + reviewer); steps 3-4 were
self-verified with tests. A final cross-step reviewer run glitched (completed
with no emitted text), so the plan-compliance audit was done directly against
the committed code. Confirmed:

- `runtime.service.ts`: exactly **2** `isMock()` (git + reconcile seams), **0**
  direct `kubeClient.` — the step-1 extraction goal.
- Behavior-preserving defaults: `ssh.gateway=sshpiper`, `storage.provider=csi`,
  `KubernetesBackend` is the default backend, `Tar` is fallback-only
  (`PREFERENCE=[Erofs,Squashfs]`, `unwrap_or(Tar)`).
- Deferrals are coherent, not broken stubs: `ssh.gateway=in-server` prepares the
  pod side (shared key, no Pipe) and logs a startup warning — no crash;
  `storage.provider` ≠ csi **fail-fasts at construction** with a clear
  "not yet implemented; set storage.provider=csi" message (intended, documented;
  the default never triggers it); `detect_build_format` returns `BlobFormat`
  (no hard-error). No selectable value silently mis-behaves.
- Verification: server 45/45, agent-v2 52/52, typecheck + module-boundary clean,
  changed files biome-clean. Generated config-schema artifacts regenerated for
  the `ssh.gateway` + `storage.provider` additions (`f1f64474`).

**Residual risk:** the deferred SSH-listener and OCI-tar paths are unexercised
by definition; when they land they need the live Remote-SSH channel-fidelity
spike and a registry+cluster round-trip respectively before becoming default.
