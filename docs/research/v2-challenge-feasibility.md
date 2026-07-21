# v2 Challenge Feasibility: Atelier-v2 vs. Real v1 Codebase

**Status:** Research / Challenge review  
**Date:** 2025-07  
**Scope:** Does `docs/proposals/atelier-v2.md` §6 survive contact with the actual code?

---

## 0. Executive Summary

The v2 direction is sound. The substrate reuse claim (~80%) is correct. The
`SandboxSpec` contract is a clean improvement. But Phase 1's headline promise —
"control resolves all policy reads *into the spec first*, then calls
`runtime.create(spec)` once" — is **partially false** against the real code in
three concrete ways, and a fourth structural issue in the Rust agent makes Phase
2 harder than stated.

**Phase 1 verdict: RISKY — proceed with eyes open on the four hazards below.**

---

## 1. Phase 1 "Seam First" Hazard Analysis

The proposal (§5 / §6) claims every policy operation — `resolveGitHubToken`,
`syncAllToSandbox`, `cliproxy.ensureSandboxKey`, opencode warmup — can be
**resolved into a spec before a single `runtime.create(spec)` call**. Here is
what the real code shows for each.

### 1.1 `resolveGitHubToken` — ✅ Actually pre-resolvable

```
create-workspace.ts:70   const githubToken = ports.users.resolveGitHubToken(createdByUserId);
```

This is a synchronous lookup: `UserService.resolveGitHubToken(userId)`. No
side-effects, no network call. Its output feeds `collectGitCredentialFiles()`
which produces `{path, content}` pairs. **Fully pre-resolvable into `spec.files`
before boot.** No hazard.

### 1.2 `internal.syncAllToSandbox` — ⚠️ Content pre-resolvable; PUSH is post-boot

```
create-workspace.ts:82   ports.internal.syncAllToSandbox(sandboxId)
internal.service.ts:175  await this.agentClient.writeFiles(sandboxId, fileWrites);
```

`syncAllToSandbox` resolves file _content_ from `ConfigFileService`,
`AuthSyncService`, and `RegistryService` — all in-process, no pod needed. But
`InternalService.pushFilesToSandbox` then calls `agentClient.writeFiles()`, which
is an HTTP POST to the running pod's agent at `{podIp}:9998/files/write`.

The pod IP is assigned only **after** `ports.agent.waitForAgent()` returns inside
`bootNewSandbox`. The content can be pre-assembled into `spec.files`, but the
actual push is irreducibly post-boot.

The proposal's fix — embedding file content directly in `spec.files` and having
the runtime write them before processes start — is correct and achievable. The
hazard is that `InternalService` is currently a single object that both _produces_
content (policy) and _delivers_ it (calls `AgentClient`). Splitting them requires
extracting the delivery path.

Also note: `create-workspace.ts` line 82-91 runs `syncAllToSandbox` and
`ports.agent.writeFiles()` **in parallel** right now. They share the same
`FILES_SEMAPHORE` in `routes/files.rs`. Under v2, merging both into a single
`spec.files` array eliminates this race, which is a genuine improvement.

### 1.3 `cliproxy.ensureSandboxKey` — ✅ Key value pre-computable; registration can overlap

```
create-workspace.ts:37   const cliproxyKeyReg = ports.cliproxy.ensureSandboxKey(sandboxId)...
cliproxy.service.ts:167  private deriveSandboxKey(sandboxId): string {
                           const mac = createHmac("sha256", config.auth.jwtSecret)
                             .update(`cliproxy-sandbox-key:${sandboxId}`)...
```

The **key value** is deterministic HMAC — no network needed, can be computed
pre-boot and embedded in `spec.files` (as the CLIProxy provider config).
`ensureSandboxKey()` then only needs to register the pre-known key with the
external CLIProxy management API, which can overlap boot as it does today. This
is already clean in v1. No structural hazard for Phase 1.

The coupling hazard is inside `InternalService._injectCliProxyProvider()`: it
calls `cliProxyService.getSandboxApiKey(sandboxId)` during config merging. Under
v2, this merging becomes "spec assembly" in the control layer — the same
deterministic derivation happens there, never in the runtime. **Clean split.**

### 1.4 Opencode warmup — ✅ Prebuild-only, not in boot path

`opencode-warmup.ts` only runs in `prebuild-runner.ts` during snapshot creation.
It is not called during `createWorkspaceSandbox` or `restartWorkspaceSandbox`.
The proposal correctly identifies it as prebuild-side. No boot-path hazard.

### 1.5 `waitForOpencodeHealthy` — ⚠️ Pod IP required; generic liveness still post-boot

```
create-workspace.ts:106  await timer.step("opencode_healthy", () =>
                           waitForOpencodeHealthy(bootResult.sandbox.runtime.ipAddress, ...))
boot-waiter.ts:66        while (Date.now() - startTime < timeout) {
                           if (await predicate(client)) return true;  // polls {podIp}/health
```

The proposal says "Delete `boot-waiter.ts`'s opencode gate; replace with generic
per-process liveness." Correct on deleting the opencode-specific check. But any
per-process health check still requires the pod IP, which is only available after
`waitForAgent()` returns. The runtime cannot check liveness before the pod exists.

This is not a blocking hazard — liveness is naturally post-`runtime.create()`,
but it means `runtime.create(spec)` is a **blocking call that waits for process
health**, not a fire-and-forget that returns immediately after pod scheduling.
The API design (POST `/v1/sandboxes` → `{id, urls}`) is correct only if the
runtime does this waiting internally. The proposal implies as much but does not
state it explicitly.

### 1.6 `agentPassword` is generated inside `bootNewSandbox` — ⚠️ Mid-boot generated value

```
sandbox-boot.ts:73   const agentPassword = generatePassword(32);
sandbox-boot.ts:76   sandbox: { runtime: { agentPassword, ... } }
sandbox-boot.ts:104  configJson: JSON.stringify(buildSandboxConfig(..., agentPassword, ...))
```

`agentPassword` is written into the ConfigMap (config.json → `services.opencode.env.OPENCODE_SERVER_PASSWORD`), the sandbox record, and later used by `waitForOpencodeHealthy` and forward-auth. Under v2 this must either:

- Be pre-generated by the control layer and included in `spec.env`, OR
- Be generated by the runtime and returned in the `{id, urls}` response.

The second is cleaner (it's a runtime credential) but requires the API contract to carry it. The proposal's returned `{id, urls}` doesn't mention it. **Minor gap in the API contract.**

### 1.7 `sandboxHasDev` in `finalizeNewSandbox` — ❌ Policy workspace lookup inside runtime kernel

```
sandbox-boot.ts:207  function sandboxHasDev(sandbox: Sandbox, ports: SandboxPorts): boolean {
                       const workspace = sandbox.workspaceId
                         ? ports.workspaces.getById(sandbox.workspaceId)  // ← policy lookup
                         : undefined;
                       return !!resolveDevConfig(workspace?.config);
                     }
sandbox-boot.ts:185  const urls = buildUrls(sandboxId, sandboxHasDev(sandbox, ports));
```

`finalizeNewSandbox` calls `ports.workspaces.getById()` — a `WorkspaceService`
lookup — to decide whether to include a `dev` URL. This is a **concrete
mechanism↔policy coupling inside the runtime kernel** that the DI split must
explicitly break. Under v2, `spec.ports` carries whether there's a dev port.
`buildUrls` should iterate `spec.ports`, not query the workspace. This is
achievable, but it must be tracked as an explicit refactor target: the function
call is not obvious from the proposal text.

### 1.8 `GuestOps.startServices` — ❌ Manager drives service starts post-boot; no phase concept in agent

```
create-workspace.ts:115  await timer.step("start_services", () =>
                            GuestOps.startServices(ports.agent, sandboxId, bootServiceNames()))
sandbox-boot.ts (main.rs:44)  // Services are started by the manager after config push via
                               // POST /services/{name}/start
                               // tokio::spawn(async { ... start_autostart_services() ... });  ← DISABLED
```

The Rust agent's autostart loop is **explicitly disabled** in `main.rs`. Services
are started by the TS manager calling `POST /services/{name}/start` for each
boot-time service. Under v2, `postCreate`/`postStart` hooks in the agent would
replace this, but that's Phase 2 Rust work (§6 step 2). 

**Phase 1 without Phase 2 agent upgrades cannot fully seal the runtime boundary**:
after `runtime.create(spec)` returns, the manager must still POST `/services/...`
to start processes. The seam leaks service-start policy into post-boot HTTP calls
unless the Rust agent's hook execution is built first. Phase 1 and Phase 2 are
more entangled than the proposal implies.

---

## 2. `SandboxPorts` DI Split: Mechanism vs Policy Cycles

The proposal calls for splitting `SandboxPorts` into mechanism deps
(`AgentClient`, `SandboxRepository`, `Kube`) and policy deps
(`UserService`/`WorkspaceService`/`ConfigFileService`/`CLIProxyService`/`InternalService`).

The actual `SandboxPorts` interface:

```typescript
// sandbox-ports.ts
export interface SandboxPorts {
  agent: AgentClient;          // mechanism
  sandbox: SandboxRepository;  // mechanism
  workspaces: WorkspaceService;// policy ← leaks into kernel (sandboxHasDev)
  users: UserService;          // policy
  configFiles: ConfigFileService; // policy
  sshKeys: SshKeyService;      // policy ← leaks into bootNewSandbox
  internal: InternalService;   // policy/mechanism HYBRID
  cliproxy: CLIProxyService;   // policy
}
```

The split is **mostly clean** but three specific cycles must be addressed:

### 2.1 `InternalService` is a mechanism↔policy hybrid

```typescript
// internal.service.ts constructor
constructor(
  private readonly authSyncService: AuthSyncService,     // policy
  private readonly configFileService: ConfigFileService, // policy
  private readonly settingsRepository: SettingsRepository, // policy
  private readonly agentClient: AgentClient,              // MECHANISM
  private readonly sandboxService: SandboxRepository,    // mechanism
)
```

`InternalService` holds `AgentClient` directly. Under v2, the runtime-side of
`InternalService` (file delivery) belongs to the runtime; the policy-side (config
merging) stays in the control layer. The class must be split. This is a
real refactor, not a rename.

### 2.2 `CLIProxyService` ↔ `InternalService` mutual injection

```typescript
// cliproxy.service.ts constructor takes InternalService
// internal.service.ts:  setCliProxyService(service: CLIProxyService): void
```

There is a circular dependency broken via setter injection. Under v2 the
`CLIProxyService` produces provider config content; `InternalService` merges it.
Both become part of spec assembly in the control layer. The circular dep is a
wiring smell but not a blocker — it dissolves when both become steps in a linear
spec-assembly pipeline.

### 2.3 `sshKeys.getValidPublicKeys()` in `bootNewSandbox`

```typescript
// sandbox-boot.ts:107
authorizedKeysData: encodeSshAuthorizedKeys(ports.sshKeys.getValidPublicKeys()),
```

`SshKeyService` (policy — it knows about users and their SSH keys) is called
inside `bootNewSandbox` (runtime kernel) to build the authorized_keys ConfigMap
entry. Under v2, this becomes part of spec assembly: the control layer resolves
`spec.files` to include authorized_keys content. **One additional pre-resolution
step, easily added.**

**Conclusion on DI split:** The split is achievable. The genuinely hard part is
extracting the delivery half of `InternalService`. The `WorkspaceService` leak in
`sandboxHasDev` and the `SshKeyService` leak in `bootNewSandbox` are both
pre-resolution candidates — straightforward once identified.

---

## 3. Agent-Rust Extensions: Real Difficulty Ratings

### 3.1 Phased hooks (`postCreate`, `postStart`, `onResume`) — **MEDIUM-HARD**

No hook system exists. `main.rs` has the autostart loop disabled. Adding phases
requires:
- A hook-execution engine in Rust (run a list of shell commands in sequence,
  capture exit codes, abort-on-failure semantics for critical hooks)
- A way for the manager to signal "resume" vs "fresh boot" — currently the agent
  has no such concept. Config.json's `created_at` could serve but it's a timestamp
  set by the manager, not a lifecycle signal.
- The `onResume` primitive requires the Rust agent to distinguish a pod that started
  fresh from a pod that started from a paused PVC. This distinction is currently
  not tracked anywhere in config.json.

**Effort estimate:** ~2–3 days Rust + integration testing. Not trivial, but the
existing `ProcessRegistry` pattern is a good template.

### 3.2 Ad-hoc `POST /processes` — **LOW**

```rust
// routes/process_manager.rs
pub async fn start_process(&self, params: StartParams<'_>) -> Result<ManagedProcess, String> {
```

`ProcessRegistry.start_process` already takes arbitrary `StartParams`. Adding a
`POST /processes` route that calls it without requiring a pre-declared
`config.json` service entry is ~30 lines of new router + handler code. The
`RUNNING_SERVICES` static registry already handles the process lifecycle.

**Effort estimate:** ~1 day.

### 3.3 Generic N-port forwarder — **MEDIUM**

Current forwarder:
```rust
// main.rs:59-63
let (dev_listen, dev_target) = config::get_config()
    .and_then(|c| c.dev_forwarder)
    .map_or((DEV_PORT, DEV_APP_PORT), |f| (f.public_port, f.app_port));
tokio::spawn(async move { forwarder::run(dev_listen, dev_target).await; });
```

`forwarder.rs` has one `pub async fn run(listen_port, target_port)`. Generalizing
to N ports requires:

1. A mutable port registry (the current `LazyLock<SandboxConfig>` is immutable —
   see §3.5 below)
2. Spawning a `forwarder::run` task per port entry
3. A route to add/remove port forwards dynamically (`POST /ports`)

The forwarder logic itself (bidirectional TCP copy with retry) is solid and
reusable. The problem is (1): config is currently loaded once and frozen.

**Effort estimate:** ~2–3 days including the config mutability refactor.

### 3.4 Unified terminal/ACP attach — **MEDIUM-HARD**

Terminal (`terminal.rs`, ~400 lines): uses `fork()` + `openpty()` + raw fd async.
ACP (`acp.rs`, ~350 lines): uses `tokio::process::Command` with piped stdio.

They share `bridge.rs` infrastructure (`OutputBuffer`, `generate_session_id`,
`parse_session_id_from_request`). But their event loops are architecturally
different — PTY needs `AsyncFd<PtyMasterFd>` and raw `libc::read/write`; ACP uses
`tokio::io::AsyncReadExt` on piped stdout.

The proposal's "three attachment modes: none / stdio-bridge / pty" is achievable:
- `stdio: "bridge"` = current ACP, parameterized per-process
- `pty: true` = current terminal, parameterized per-process
- Default (none) = no attachment endpoint

The bridge WS server must be either per-port (each process gets its own port,
messy) or multiplexed (one WS server routes by session ID, current model). The
current model (one TCP listener per service type, session ID from URL) already
supports per-process sessions — the refactor is to make the bridge a generic
function that spawns a WS listener for any `(port, launch_params)` pair.

The terminal PTY code is deeply entangled with the `fork()`/uid-setting/devpts
mounting logic. This is correct for PTY sessions but shouldn't be generalized
with stdio bridges; they should stay separate implementations behind a common
interface.

**Effort estimate:** ~4–5 days for clean generalization. Harder than the proposal
implies because PTY and stdio are genuinely different at the OS level.

### 3.5 `PATCH /files` — ✅ Already exists

```
router.rs:16  (Method::POST, "/files/write") => routes::files::handle_write_files(req).await,
```

`POST /files/write` with `{ files: [{ path, content, mode?, owner? }] }` already
exists and is used by the TS manager for every boot. Renaming/exposing this
through the v2 API is trivial. **~1 hour.**

### 3.6 `PATCH /env` — **MEDIUM**

The Rust agent reads `SANDBOX_CONFIG` as a `LazyLock<RwLock<Option<SandboxConfig>>>`:

```rust
// config.rs:69-73
pub static SANDBOX_CONFIG: LazyLock<RwLock<Option<SandboxConfig>>> = LazyLock::new(|| {
    let config = std::fs::read_to_string(CONFIG_PATH).ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    RwLock::new(config)
});
```

The config is loaded once from `/etc/sandbox/config.json` at startup. All service
start logic reads `ServiceConfig.env` from this frozen config. To make `PATCH /env`
affect future process spawns, either:
- Write-back to `SANDBOX_CONFIG` (requires wrapping env in a separate mutable
  overlay, since `SandboxConfig` is serde-derived and complex to partially mutate)
- Maintain a separate `ENV_OVERLAY: RwLock<HashMap<String, String>>` that
  `start_service_internal` merges in at spawn time

The second pattern is cleaner. The proposal's stated semantics ("fires an
`envChanged` hook the user wires to reload/SIGHUP their processes; does NOT
mutate a running process's environment") are **honest and correct**: Linux
`/proc/PID/environ` is read-only from outside the process. This is a real
platform limitation, not a design choice.

**Effort estimate:** ~2 days for the env overlay + hook notification.

### 3.7 `onResume` execution — **MEDIUM**, depends on lifecycle signal

The current pause model (pod delete + PVC keep) means the agent cannot distinguish
a fresh boot from a resume at startup. The manager knows: it either calls
`bootNewSandbox` (fresh) or `bootExistingSandbox` (restart/resume). Under v2,
the spec could carry `resume: true` as a field, or the runtime could store
a "was paused" marker on the PVC (e.g., a file at `/etc/sandbox/.resumed`).

The simplest implementation: the manager writes a file `/etc/sandbox/.resuming`
before boot (as part of spec assembly), the agent reads it at startup and runs
`onResume` hooks, then deletes it. No new API needed.

**Effort estimate:** ~1–2 days once phased hooks exist.

---

## 4. Physics Claims Verification

### 4.1 `onResume` credential rotation — ✅ Achievable, one ordering constraint

The claim: inject fresh creds at resume time, atomically, before processes restart.

Current code: in `restartWorkspaceSandbox`, the sequence is:
1. `bootExistingSandbox()` → new pod, wait for agent health
2. `ports.agent.writeFiles()` with secrets + git creds
3. `GuestOps.startServices()` starts opencode etc.

Steps 2 and 3 are correctly ordered: files are written before services start.
Under v2, embedding creds in `spec.files` and having the runtime write them
before executing `processes[]` achieves the same guarantee structurally.

**The one ordering constraint**: the `agentPassword` (used for forward-auth) must
be rotated in the service URL before processes start. Currently it's regenerated
per-restart in `bootExistingSandbox` and embedded in the ConfigMap. Under v2,
if the password comes from `spec.env`, it must be consumed by the runtime before
starting the OpenCode process. **This works as specified.**

### 4.2 `PATCH /env` NOT mutating live processes — ✅ Honestly stated

The claim is honest. Linux process environments are mutable only from within the
process itself (`setenv()`/`putenv()`). External mutation via
`/proc/PID/environ` is read-only from Linux 5.x onward (even the write worked
at best on the metadata, not the process's actual env block). The `envChanged`
hook pattern is the correct approach. **No exaggeration here.**

### 4.3 Pause = pod-delete + PVC-keep — ✅ Already implemented

```typescript
// sandbox-boot.ts: deleteRestartableSandboxResources()
// Deletes: Pod, ConfigMap, Service, SshPipe, labeled Ingresses
// Does NOT delete: PVC (pvcName = `sandbox-${sandboxId}`)
```

The PVC is explicitly not deleted in `deleteRestartableSandboxResources`. On
restart, `bootExistingSandbox` creates a new pod referencing the same `pvcName`.
The current behavior is exactly "disk-only, cold-ish resume" as described.

Memory snapshots (CRIU/Kata snapshot) are listed as an open question (§8.2),
not a claim. **Honest.**

### 4.4 Snapshot rekeying (workspace-ID → substrate-hash) — ⚠️ Infrastructure change required

Currently:
```
PVC name:      sandbox-{sandboxId}
Snapshot name: workspace.config.prebuild.latestId (e.g. "prebuild-ws-abc123-1234567890")
```

The proposal claims rekeying to `hash(source.image ⊕ prebuild files ⊕ hooks.build ⊕ repos)`.
On k3s/TopoLVM, `VolumeSnapshot` names are immutable after creation. Rekeying
requires either:
- Creating new `VolumeSnapshot` objects pointing to the same `VolumeSnapshotContent`
  (snapshot aliasing — not natively supported by the CSI spec; requires
  `VolumeSnapshotContent` with `volumeSnapshotRef` pointing to a new name)
- A migration step that creates alias records mapping old names to new content-hash
  keys

This is achievable but requires a CSI-level migration plan. The proposal mentions
"a one-time alias" — correct in concept, non-trivial in implementation on
standard CSI. **Not a blocker but more work than implied.**

---

## 5. `stdio: bridge` Single-Writer Generalization

The proposal claims ACP's WS bridge is "already protocol-transparent" and
just needs to stop being named "acp" in the core.

**This is largely true**, with one qualification:

```rust
// acp.rs: ensure_acp_from_config()
pub async fn ensure_acp_from_config() {
    let Some(service) = config.services.get("acp") else { return };
    ...
    ensure_acp_running(port).await;
}
```

The ACP bridge is hardcoded to look up the `"acp"` service key in config.json.
It starts one WS server on one port. For the generic `stdio: "bridge"` model
(any process can request a bridge), each process would need its own WS listener
on its declared port. The `AcpState` static holds `port + sessions` — it would
need to become a registry of `(port → AcpState)` entries, one per bridged process.

`acp.rs` is already a clean byte relay: it never parses JSON-RPC, it has session
management with replay buffers, lag detection, and WS teardown. The code is
genuinely reusable. The changes required:
1. `ensure_acp_running(port)` → `ensure_bridge_running(port, process_name)` that
   starts per-process WS servers
2. Route from `POST /acp/sessions` → `POST /processes/{name}/attach` or similar
3. Remove the `"acp"` hardcoded key lookup

This is **real, not hand-wave**, but it's a moderate refactor (~1–2 days), not a
rewrite. The proposal's description is accurate.

**Single-writer claim**: the proposal says "the bridge allows one writing client
at a time (later attaches are read-only or rejected)." The current implementation
uses a `broadcast::Sender` for output (fan-out to all WS clients) and an
`mpsc::Sender` for input (single logical writer, though multiple WS connections
can each `write_tx.send()` independently). In practice, concurrent writers
interleave bytes, corrupting the JSON-RPC stream. The single-writer enforcement
does NOT currently exist in `acp.rs` — it needs to be added. **Not a blocker,
but it's a TODO, not "already works."**

---

## 6. Hazard List, Ranked by Severity

| # | Severity | Hazard | File:line Evidence |
|---|---|---|---|
| 1 | **HIGH** | Manager drives service starts post-boot via HTTP; Rust agent autostart is disabled. Phase 1 seam leaks service-start policy until Phase 2 Rust hooks land. | `main.rs:44` (disabled autostart), `create-workspace.ts:115` (`startServices`), `routes/services.rs` |
| 2 | **HIGH** | `sandboxHasDev()` in `finalizeNewSandbox` calls `ports.workspaces.getById()` — policy lookup inside runtime kernel. DI split incomplete without explicit extraction. | `sandbox-boot.ts:207–212` |
| 3 | **HIGH** | `InternalService` holds `AgentClient` (mechanism) and is called from policy-resolution contexts. Delivery half must be extracted for the control/runtime split to be clean. | `internal.service.ts:18-25`, `internal.service.ts:175` |
| 4 | **MEDIUM** | `SANDBOX_CONFIG` is a `LazyLock` — loaded once, never mutated. `PATCH /env`, N-port forwarding, and any live config update require a mutable config layer that does not exist. | `config.rs:69-73`, `main.rs:59-63` |
| 5 | **MEDIUM** | Phase 1 + Phase 2 sequencing risk: completing the seam (runtime.create handles everything) requires Rust phased hooks (Phase 2). Without them, Phase 1 is a partial seam that still needs post-`runtime.create` HTTP calls from the manager. | `create-workspace.ts:115`, proposal §6 step 1 vs step 2 |
| 6 | **MEDIUM** | `agentPassword` is generated inside `bootNewSandbox`, embedded in ConfigMap + sandbox record + forward-auth. The v2 API contract (`{id, urls}`) doesn't mention returning it; it needs explicit placement in the spec or the return value. | `sandbox-boot.ts:73-76` |
| 7 | **MEDIUM** | Single-writer enforcement on the ACP bridge does not exist. Concurrent WS writers interleave bytes, corrupting JSON-RPC. Must be added as part of the `stdio: bridge` generalization. | `acp.rs:167–193` (WS handler: no exclusion on `write_tx`) |
| 8 | **LOW-MEDIUM** | Snapshot rekeying from workspace-ID to substrate-hash requires CSI-level aliasing, not just a code change. Standard CSI does not support snapshot renaming. | `prebuild-runner.ts`, k3s/TopoLVM CSI docs |
| 9 | **LOW** | Terminal PTY and ACP stdio bridges share `bridge.rs` infrastructure but have fundamentally different event loops (raw fd vs tokio async). "Unified attach" requires separate implementations behind a common interface — more work than implied. | `terminal.rs:1-400`, `acp.rs:1-350`, `bridge.rs` |
| 10 | **LOW** | `CLIProxyService ↔ InternalService` circular dep broken by setter injection. Dissolves when both become spec-assembly steps, but the wiring is fragile during the transition. | `internal.service.ts:setCliProxyService()`, `cliproxy.service.ts` constructor |
| 11 | **INFO** | `AGENT_PORT = 9998` in `config.rs:5` vs Helm chart `ports.agent: 9999` drift mentioned in proposal. Confirmed: the code uses 9998. | `config.rs:5` |

---

## 7. Go/Risky/No-Go on Phase 1

### Verdict: **RISKY — proceed with explicit prerequisites**

Phase 1 is correctly identified as the highest-risk phase. The concept is sound
but the "resolve everything up front" claim requires these **explicit pre-conditions**:

**Before Phase 1 can ship a complete seam:**

1. **Extract delivery from `InternalService`**: the content-producing half stays
   in the control layer (spec assembly); the delivery half (`pushFilesToSandbox`)
   becomes an internal runtime mechanism.

2. **Remove `ports.workspaces` from `finalizeNewSandbox`**: `buildUrls()` must
   iterate `spec.ports`, not call `sandboxHasDev()`.

3. **Pre-resolve `sshKeys.getValidPublicKeys()`** into the spec before `runtime.create()`.
   One-line addition to spec assembly.

4. **Decide on `agentPassword` ownership**: pre-generate in control layer and
   put in `spec.env`, OR have the runtime generate + return it. Update the API
   contract.

**Known limitation at Phase 1 boundary** (acceptable if documented):

- Service starts still happen via post-`runtime.create()` HTTP calls to the agent
  until Phase 2 Rust hooks land. The seam is established as a typed boundary,
  not yet a full isolation barrier. Gate this on Phase 2 agent upgrades before
  declaring the seam closed.

**The diffing gate** mentioned in the proposal ("gate it on diffing the produced
`config.json`/K8s resources against v1's for identical inputs") is the right
validation approach and is achievable since `buildSandboxConfig` is already
a pure function testable in isolation.

---

## 8. Honest Hardest Part

The hardest single thing in the v2 migration is not the DI split, not the Rust
agent extensions in isolation, but the **intersection of two facts**:

1. The Rust agent's `SANDBOX_CONFIG` is immutable after load (`LazyLock`). This
   is load-bearing: `acp::ensure_acp_from_config()`, `terminal::ensure_terminal_from_config()`,
   and `forwarder::run()` all read config exactly once at startup. Live config
   updates (`PATCH /env`, N-port forwarding, `onResume` signals) all require
   mutability that doesn't exist.

2. Phase 1 claims to close the seam, but the seam is only closed when the runtime
   handles service starts internally (phased hooks). Phased hooks require the
   agent to execute hook commands in response to lifecycle events, which means
   the agent must know what lifecycle phase it's in — currently it doesn't.

Together, these mean **Phase 2 Rust work is a prerequisite for Phase 1's headline
promise**, not a follow-on. The proposal's "behavior-preserving refactor" framing
for Phase 1 is correct only if Phase 1 is scoped to the seam as a typed module
boundary (not a fully sealed runtime). That scoping is fine, but it must be
stated explicitly so Phase 1 doesn't ship with a false claim that
`runtime.create(spec)` is the single call.

---

## 9. Cross-references

- `docs/proposals/atelier-v2.md` — proposal under review
- `docs/research/fastboot-snapshot-economics.md` — physics constraints (§2.1 network
  state not preserved; §5 overlay model) are correctly reflected in the proposal.
  The "pause = cold-ish resume" claim is accurate per §2.6 (Kata containers use
  fast VM boot, not CRIU). The `onResume` hook pattern matches the recommended
  model in §5 (post-resume hooks for credentials, clock sync, etc.).
