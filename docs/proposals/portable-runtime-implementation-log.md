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

(Continued below.)
