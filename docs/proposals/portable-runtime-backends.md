# Portable Runtime Backends — a `SandboxBackend` Seam Below the Runtime

**Status:** proposal / design note
**Refines:** [`generic-sandbox-architecture.md`](./generic-sandbox-architecture.md)
§4 (the mechanism/policy planes). That doc drew the **Plane 1 / Plane 2**
seam (`runtime.create(spec)`) so policy can't reach mechanism. This doc draws
a **second seam _below_ Plane 2** — a `SandboxBackend` port — so the runtime's
backend-neutral logic (op-locks, content-addressed prebuild dedup, phase
ordering, pause/resume bookkeeping, GC guards) stops being welded to
Kubernetes + CSI + a Linux-kernel mount model, and can drive Docker or a local
process instead.
**Does not change:** the `SandboxSpec` contract, the guest agent's HTTP API,
or any Plane-1 policy. This is a mechanism-tier refactor plus new backends.

---

## 1. Problem

The dream: self-hostable Atelier — locally, on Docker, on a developer's laptop
(including a Mac, inside the Linux VM Docker already runs), so people can
experiment without a k3s + Kata + TopoLVM cluster. Before the dream: smoother
Kubernetes, compatibility with other storage drivers, other prebuilt/toolbox
formats.

Today `RuntimeService` (`apps/server/src/runtime/runtime.service.ts`) is "the
seam" — but only against _policy_. Against _infrastructure_ it is hardwired:

- **~21 direct `kubeClient.` calls** across the runtime (`boot.ts` ×8,
  `runtime.service.ts` ×9, `kube/ssh-pipe-key.ts` ×3, `cleanup.ts` ×1).
- **~31 `isMock()` branches** in `runtime/` (5 of them in `runtime.service.ts`)
  — the only current "other backend" is a scatter of `if (isMock()) return …`
  short-circuits, not a real seam.
- `boot.ts` _is_ "build a Pod + PVC + Service + Ingress + sshpiper Pipe and
  POST them to the API server" (`createSandboxResources`, boot.ts:174-217).
- Storage _is_ CSI: `VolumeSnapshot` + `PersistentVolumeClaim.spec.dataSource`
  cloning (`snapshotPvc` runtime.service.ts:949; `buildPvc({snapshotName})`).
- Toolset materialization _is_ a Linux-kernel mount model: erofs/squashfs
  loop-mounts + overlayfs + `CAP_SYS_ADMIN` (`apps/agent-v2/src/toolset.rs`).

Note the transport is _already_ half-abstracted: `AgentClient` takes an
injected kube handle (`constructor(private readonly kube = kubeClient)`,
agent.client.ts:65) and funnels every call through `resolvePodIp` /
`getAgentUrl`. That injection point is the model for the whole design.

---

## 2. The blockers, sorted by how hard they truly are

| Concern | Hardness | Why |
|---|---|---|
| K8s API (Pod/Service/Ingress/PVC), Kata `runtimeClass`, Ingress + cert-manager | **Soft** | Orchestration/isolation/routing mechanisms. Every capability (run a container, give it an endpoint, expose a port, give it a disk) has a Docker/local equivalent. Isolation weakens off-Kata; acceptable on a laptop. |
| sshpiper CRD + Deployment (SSH ingress) | **Soft — and now optional** | Not a hard dependency: the auth material already lives server-side and the server already dials pod IPs, so an in-server SSH proxy replaces it (§5). Becomes one opt-in strategy, not a required component. |
| CSI `VolumeSnapshot` + PVC `dataSource` clone (TopoLVM/LVM-thin) | **Medium-hard** | The _instant CoW clone_ is the value. Alternatives (btrfs/zfs snapshot, `cp --reflink`, plain `cp`/tar) each is a real snapshot-provider impl **and changes the consistency contract** (§6). |
| erofs/squashfs + overlayfs + loop + `SYS_ADMIN` | **Medium** | Needs a Linux guest kernel with those modules + the privilege. The agent picks erofs-vs-squashfs by kernel probe today but **hard-errors when neither exists** — there is _no copy fallback yet_ (§7). |
| A Linux kernel at all | **Hard on native macOS** | overlayfs/loop/erofs don't exist on Darwin. Mac can only ever run this _inside a Linux VM_ (Docker Desktop / Lima / OrbStack). "Native mac filesystems" is not reachable for the mount-based toolset design. |

**Honest headline:** _native-macOS-with-mac-filesystems is out of scope_; but
_"Docker on a Mac laptop"_ is fully reachable and covers ~95% of the
"developers experiment locally" goal.

---

## 3. The seam: a `SandboxBackend` port (+ `VolumeBackend` sub-port)

Split `RuntimeService` into **backend-neutral orchestration** (stays) and a
**`SandboxBackend` interface** it drives (new). Only the leaf "make a container
exist / clone a disk / build a URL" calls move behind the port.

```ts
interface SandboxBackend {
  // ── lifecycle (today's boot.ts / cleanup.ts, minus K8s specifics) ──
  runSandbox(id: string, spec: SandboxSpec, input: RunInput): Promise<RunHandle>
  stopSandbox(id: string, opts: { preserveDisk: boolean }): Promise<void>  // pause/resume teardown
  destroySandbox(id: string): Promise<boolean>                              // full sweep; false ⇒ keep record
  sandboxExists(id: string): Promise<boolean>                               // startup reconciliation

  // ── transport: replaces getPodIp; the agent client dials this ──
  resolveAgentEndpoint(id: string): Promise<AgentEndpoint>   // { host, httpPort, attachPort }

  // ── networking + URL construction (BOTH read and write sides — see §4) ──
  exposePort(id: string, port: PortEntry): Promise<void>     // live addPort
  urls(id: string, spec: SandboxSpec): SandboxUrls           // read side: replaces urlsFor's URL shaping
  sshTarget(id: string): SshTarget                           // what to print: `ssh <id>@gw` vs `ssh -p <port> …`

  // ── storage varies independently ──
  volumes: VolumeBackend
}

// SSH routing is a SEPARATE, pluggable strategy (§5) — not folded into the
// backend, but backend-aware (it needs resolveAgentEndpoint to find pod:22).
interface SshGateway {
  publicTarget(id: string): SshTarget          // host/port/username the dev connects to
  // (in-server strategy owns a listening socket + host key; external/none own nothing)
}

interface VolumeBackend {
  createVolume(id: string, opts: { size: string; fromSnapshot?: SnapshotRef }): Promise<VolumeRef>
  reuseVolume(id: string): Promise<boolean>                  // resume: does the live disk still exist?
  snapshotVolume(ref: VolumeRef, name: string): Promise<SnapshotRef>  // CoW if available, copy otherwise
  deleteVolume(ref: VolumeRef): Promise<void>
  deleteSnapshot(ref: SnapshotRef): Promise<void>
  readySnapshotTimeoutMs: number                             // backend-sized (§6)
}
```

**What stays in `RuntimeService` (genuinely backend-neutral, verified):**
`withOpLock` (per-id lifecycle serialization), `resolveContentKey` /
`resolveRepoHeads` (content-hash prebuild dedup), the fixed phase order
(files/env → postCreate → reconcile → primary-gate → postStart),
`referencedSnapshotRefs` / `referencedToolsetRefs` (GC guards), the
pause→snapshot→delete-pod→resume bookkeeping, and inflight-dedup maps. None of
these touch a K8s object; they operate on records + refs the port returns.

**`isMock()` → a `MockBackend`** — but **scoped** (see §9 risk): only the
sandbox/volume mock branches fold in. Git-`ls-remote` and registry-HTTP mock
branches (`resolveRepoHeads` runtime.service.ts:330; registry service) belong
to _different_ seams and stay their own mock paths.

---

## 4. Leak audit — what the port surface must capture (do not under-spec)

The seam is sound, but three leaks go _beyond_ container lifecycle and were
easy to miss; the interface above already accounts for them:

1. **URL/response-contract leak (biggest).** `urlsFor()` runs on the **`create`
   _and_ `get` response paths** (runtime.service.ts:536, :558), not just boot.
   It hardcodes the ingress URL shape via `buildPortUrls`
   (`{name}-{id}.{baseDomain}`, ports.ts:66) and the SSH model via `sshUrl`
   (`ssh <id>@<host>`, ports.ts:108). Docker needs `localhost:<mappedPort>`
   and `ssh -p <port>`. **URL construction must move behind the backend**
   (`backend.urls()` / `backend.sshTarget()`), not just the write-side
   `exposePort`.

2. **`addPort` mutates K8s directly _inside_ RuntimeService**
   (runtime.service.ts:845 → `kubeClient.patchResource("Service"…)` +
   `buildPortIngresses`). This is a live-ops leak beyond boot. It goes behind
   `backend.exposePort`. Note the K8s shape is a **two-step** (patch the
   existing Service _and_ add an Ingress) that will not map 1:1 to a Docker
   port publish — the interface hides that, the impls differ.

3. **SSH is a _second_ network primitive, not one `exposePort`.** boot.ts
   always builds a `Pipe` CRD (boot.ts:207) + an ssh-pipe-key Secret. There
   are **two ingresses to abstract** — the agent HTTP endpoint _and_ SSH
   routing — and SSH deserves its own pluggable gateway (§5), because the
   three environments route it three different ways (in-server proxy,
   external sshpiper, backend-native port). Hence `SshGateway` /
   `sshTarget()` is separate, not folded into `exposePort`.

4. **`attachUrl` returns a raw `ws://<podIp>:9997`** (agent.client.ts:305) that
   flows to the **browser/API**. Under Docker the browser cannot reach a
   container-internal IP — attach needs a host-reachable endpoint.
   **DECIDED: mapped port per process** (docker-native, simplest, no
   multiplexer to build). `resolveAgentEndpoint` returns a _client-reachable_
   `{ host, attachPort }`; the Docker backend publishes the attach port and
   yields `127.0.0.1:<mapped>`, k8s keeps the in-cluster pod IP.

---

## 5. SSH access: gateway strategies (sshpiper becomes optional)

SSH is worth keeping — it is the "bring your own IDE" story (git-over-ssh, VS
Code / Cursor Remote-SSH, JetBrains Gateway); the browser terminal/attach WS
covers interactive shells but not native tooling. But it is **not a required
component**, and today it is welded to a separate cluster component.

### What sshpiper does today (three jobs)

A standalone sshpiper Deployment (NodePort Service, `atelier-system`) with the
`kubernetes` plugin watches `Pipe` CRDs across namespaces. Per sandbox, boot.ts
creates a `Pipe`: `from.username = <sandboxId>` + `from.authorized_keys_data`
(the dev's public keys, base64'd), `to.host = sandbox-<id>.<ns>.svc:22`,
`to.username = dev`, `to.private_key_secret = <shared key>`. So sshpiper is:
(1) **one stable public SSH entrypoint**, (2) **username → sandbox routing**,
(3) **auth** — verify the dev's key against the per-sandbox authorized set, then
dial the pod's sshd as `dev` with a shared upstream key.

### Why an in-server proxy is the right default, not overkill

Two facts collapse sshpiper's job into something the server already almost does:

- **The auth material already lives server-side.** SSH keys are in
  `control/modules/ssh-key/`; control already resolves `authorizedKeys` and
  passes them into `runtime.create()`. Today we then _base64 them back out into
  a `Pipe` CRD_ so a separate pod can re-check them — a detour around the
  server that already holds them.
- **The server already dials pod IPs directly.** `agent.client.ts` hits
  `http://<podIp>:9998`; reaching `<podIp>:22` is the same network path. No new
  connectivity, no shared-key Secret in k8s.

So sshpiper is a whole separate Deployment + CRD + RBAC + Secret + Service
(5 chart templates) **plus a per-sandbox `Pipe` create/cleanup on every boot**,
duplicating auth the server owns. Folding it in-process removes infra, shortens
boot, drops the ssh-pipe-key machinery — **and is identical on k8s / Docker /
local**, which is the whole point.

### The one real cost (the thing to de-risk)

SSH cannot be raw-TCP-spliced — it is end-to-end encrypted and the client pins
the host key. The proxy must **terminate and re-originate**: present its own
_persistent_ host key, authenticate the dev (publickey; username =
`sandboxId`; verified against control's stored keys), then open an upstream SSH
_client_ connection to `<podIp>:22` as `dev` (using the shared upstream key or a
per-sandbox one) and **faithfully forward every channel/request type**:
`session` (exec/shell/pty + env + window-change), the `sftp` subsystem, and
`direct-tcpip` (port forwarding). That last set is exactly what git-over-ssh
and VS Code / Cursor Remote-SSH exercise. This is precisely sshpiper's internal
model; the work is forwarding all of it correctly, not a novel design.

- **Library:** `ssh2` (Node). **Runs on Bun** — its core is pure-JS; the only
  native piece, `cpu-features`, is an optional accelerator ssh2 skips
  gracefully (it's on Bun's N-API tracker
  [oven-sh/bun#4290](https://github.com/oven-sh/bun/issues/4290), but ssh2 does
  not require it). A Rust/Go sidecar would work but reintroduces a separate
  component — the thing we're removing. **Remaining spike:** channel fidelity
  for VS Code / Cursor Remote-SSH (`direct-tcpip` + `sftp`), not the runtime.
- **Persistent host key — DECIDED: the control DB secrets store.** Generate once
  (lazily, first gateway start — same pattern as today's `ensureSharedSshPipeKey`
  but into the `secrets` table, not a k8s Secret), AES-256-GCM at rest
  (`control/modules/secret/crypto.ts`, keyed by `SANDBOX_SECRETS_KEY`). Chosen
  over a mounted k8s Secret (doesn't exist on Docker/local) or a disk file
  (ephemeral without a mounted volume) because the DB is **backend-agnostic**
  (identical on k8s/Docker/local) and **multi-replica safe** (every replica
  reads the same row → same host key → no client MITM warnings behind a LB). It
  inherits the control DB's existing durability requirement — no new
  persistence surface. Rotating `SANDBOX_SECRETS_KEY` re-generates the key
  (one-time client warning; rare, acceptable).
- **Upstream key — DECIDED: keep the existing shared key.** The proxy dials
  `dev@pod` with the shared ed25519 key (today's `ensureSharedSshPipeKey`
  material), not a per-sandbox key. Per-sandbox keys are deferred (§10).
- **Upstream host key:** pods are ephemeral (host keys churn); the proxy
  ignores the upstream host key inside the cluster trust boundary — the
  current `Pipe` already sets `ignore_hostkey: true`.
- **Session lifetime:** SSH sessions live in the server process, so a server
  redeploy drops live SSH connections (a standalone sshpiper survives an app
  redeploy). Acceptable for a dev tool; state it honestly.

### The three strategies (sshpiper → one opt-in among them)

| Strategy | Works on | Notes |
|---|---|---|
| **In-server proxy** (new default) | k8s / Docker / local | `ssh2` gateway in the server; auth from control; dials `pod:22`. Portable, fewest moving parts. |
| **External sshpiper** (opt-in) | k8s only | Today's behavior, unchanged. For operators wanting SSH ingress decoupled from app lifecycle / a separately hardened component. Boot still emits the `Pipe` **only when this strategy is selected**. |
| **None / direct** (fallback) | backend-native | No gateway. k8s: `kubectl port-forward svc/sandbox-<id> :22` (only for operators _with_ kubeconfig — **not an end-user path**); Docker: a published port. The dev pipes on their end. |

The port-forward fallback is real but serves only people who already hold
kubeconfig — an operator/debug tier, not the end-user SSH story. **The in-server
proxy is what makes native SSH work for real users off-cluster**, which is why
it's the default rather than a nice-to-have.

### Config surface

```jsonc
"ssh": {
  "gateway": "in-server" | "sshpiper" | "none",  // default: in-server
  "listenPort": 2222,                              // in-server: the socket it binds
  "upstreamUser": "dev"
  // host key: NOT configured here — auto-generated + persisted in the control
  // DB secrets store on first start (see "Persistent host key" above)
}
```

When `gateway != "sshpiper"`, boot **stops creating the `Pipe` CRD and the
ssh-pipe-key Secret** — removing them from the per-sandbox resource set and from
cleanup. This is the concrete "make sshpiper optional" change, independent of
the Docker backend.

---

## 6. Storage: the degradation ladder (and its consistency contract)

The runtime does **not** assume CoW — `snapshotPvc` just creates a CSI object
and waits `waitForVolumeSnapshotReady(timeout: 120_000)` (runtime.service.ts:964);
the CoW-ness is entirely in the driver. So a copy-based `VolumeBackend` slots
in cleanly. Same pause/resume/prebuild logic, different clone primitive:

| Environment | Clone primitive | Speed | Consistency |
|---|---|---|---|
| Prod k8s (today) | CSI `VolumeSnapshot` + PVC `dataSource` (TopoLVM/LVM-thin) | instant CoW | crash-consistent (block snapshot of live PVC after `sync`) |
| Docker on btrfs/zfs host | `btrfs subvolume snapshot` / `zfs clone` of a bind-mount dir | instant CoW | crash-consistent |
| Docker on ext4/xfs w/ reflink | `cp --reflink=auto` | near-instant | **weaker** — file-granular copy of a live dir |
| Docker Desktop / Mac / any | plain `cp -a` / `tar` of a directory | slow | **weakest** — files copied at different instants, not even crash-consistent |
| Prebuild artifact | **OCI image or `.tar.zst`** instead of a VolumeSnapshot | portable everywhere | n/a (built artifact, quiesced) |

**Three correctness caveats the copy tiers must own:**

- **Consistency contract shifts, not just speed.** `pause()` does a best-effort
  `sync` then snapshots a _live_ PVC ("crash-consistent, not clean",
  runtime.service.ts:591-596). A `cp`/tar of a _live directory_ is **worse than
  a block snapshot** — it isn't even crash-consistent. **DECIDED for Tier 2:
  stop-then-copy** (pause already deletes the pod right after snapshotting —
  copy backends reorder to stop-first, then copy the quiesced disk). This is
  acceptable _only_ paired with a **progress-surfacing workstream** (see §10):
  stop-then-copy makes pause visibly slower, so the console + CLI must show a
  loader + honest wording driven by backend→UI progress events. That event
  plumbing is a **distinct effort** (a broad review of every UI info surface),
  sequenced with the Docker backend, not assumed free here.
- **Timeouts are backend-dependent.** `waitForVolumeSnapshotReady`'s 120s is
  sized for CoW; a plain multi-GB `node_modules` home copy can exceed it. Hence
  `VolumeBackend.readySnapshotTimeoutMs`.
- **PVC-reuse-on-resume ports cleanly but its k8s reasoning doesn't.** The
  resume "is the live disk still here?" check
  (`resourceExists("PersistentVolumeClaim"…)`, runtime.service.ts:638) maps to
  "does the container's volume dir still exist" for Docker — clean. But the
  `WaitForFirstConsumer` late-binding assumption (boot.ts:101) is k8s-only and
  simply has no Docker analogue (fine — just don't port the comment's logic).

**Prebuild-as-OCI/tar is a first-class insight:** a prebuild need not be a
`VolumeSnapshot`. The content-hash key (`resolveContentKey`, runtime.service.ts:303
— hashes source+files+build+repoHeads) is _already_ storage-agnostic. On k8s
you clone a snapshot; on Docker you `docker pull` / extract a `.tar.zst` into
the volume dir. **Same key, different materialization.** This is where "bring
back tar.gz" fits — it is the **portable fallback tier**, not a regression.

**DECIDED — prefer CSI VolumeSnapshot, else OCI `tar.zst`:** each
`VolumeBackend` picks the fastest materialization its host supports — a CSI
`VolumeSnapshot` clone where available (instant CoW), otherwise an OCI
`tar.zst` artifact pulled + extracted. The content key is identical either
way, so a prebuild built on one substrate stays addressable on another; only
the artifact envelope differs.

---

## 7. Toolsets: add a `Tar` blob rung (real work, not a footnote)

The agent is **not** yet format-agnostic. `BlobFormat` has exactly two variants
(`Erofs`, `Squashfs`; toolset.rs:66-68) and `detect_build_format` **hard-errors**
— _"guest kernel supports neither erofs nor squashfs; cannot build a toolset
blob"_ (toolset.rs:134) — when both are absent. Going fully portable adds a
third rung, **`Tar` (extract-into-dir)** — exactly the copy-in path the
squashfs proposal replaced, now resurrected as an explicit _fallback_:

- **Selected when** the kernel lacks erofs _and_ squashfs, **or** the backend
  cannot grant `SYS_ADMIN` / loop devices (rootless/locked-down Docker).
- **Real surface, not an enum add:** a build path (`tar`/`tar.zst` instead of
  `mkfs.*`), a **mount-vs-copy branch in `materialize`** (extract into the
  overlay lower dir instead of loop-mounting), a new OCI media-type, and a
  **non-privileged capability probe** (can I loop-mount + overlay here?) that
  gates format selection at both build and materialize.
- **Runtime is unaffected:** it still just passes refs to `materializeToolsets`;
  the agent picks mount-vs-copy from its own probe. Composition stays N + M.

The result: "mount if you can, copy if you must." Slower boots where privilege
or kernel modules are missing; runs everywhere.

---

## 8. Portability tiers (honest expectations)

- **Tier 0 — prod k8s + Kata + TopoLVM** (today): VM isolation, instant
  everything.
- **Tier 1 — Docker, single host, CoW FS** (btrfs/zfs/reflink): near-full
  speed, container isolation instead of VM. The realistic "a team runs it on a
  box" target.
- **Tier 2 — Docker Desktop / Mac / rootless**: works; snapshots → copies,
  toolsets → tar-extract, weaker consistency. The "developer experiments
  locally" target.
- **Tier 3 — bare `LocalProcessBackend`, no Docker**: last resort for ancient
  laptops; weakest isolation, no VM, no kernel-mount toolsets.

**Native-Darwin-filesystem is explicitly _not_ a tier** — "on a Mac" means "in
the Linux VM Docker/Lima already runs."

---

## 9. Sequencing (reality before dream) + risks

1. **Extract `SandboxBackend` + `VolumeBackend` from `RuntimeService`** as a
   behavior-preserving refactor: current code becomes `KubernetesBackend` /
   `CsiVolumeBackend`. Move `urlsFor` URL-shaping, `addPort`, and `getPodIp`
   behind the port (§4).
   - **Risk — not purely no-behavior-change:** "fold isMock into MockBackend"
     crosses three seams. Scope step 1 to **only** the sandbox/volume isMock
     branches; leave git-`ls-remote` and registry-HTTP mock paths as their own
     seams, or you either couple them wrongly or leave residual `isMock`.
2. **Make SSH a pluggable `SshGateway` (§5)** — extract the `Pipe` + ssh-pipe-key
   emission behind the `sshpiper` strategy, add the `none` strategy, and land
   the `in-server` `ssh2` proxy. Independently shippable and valuable on k8s
   _before_ any Docker work, since it deletes 5 chart templates + a per-boot
   resource. De-risk with a channel-fidelity test matrix: shell, exec,
   git push/pull, sftp, VS Code Remote-SSH, `-L`/`-R` port forward.
3. **Dual-format prebuild/toolset artifacts** — `VolumeSnapshot | OCI-tar` for
   prebuilds; decouples the artifact from the storage driver (§6).
4. **Add the `Tar` blob rung + capability probe in `agent-v2`** (§7) — no
   runtime changes; the real portability enabler for locked-down/rootless.
5. **Write `DockerBackend`** — the payoff. `runSandbox` = `docker run` (or a
   generated compose project) with the agent on a published port; `exposePort`
   = port publish or a bundled Traefik/Caddy doing `*.localhost`; endpoint =
   `127.0.0.1:<mapped>`; a copy/CoW `VolumeBackend` for the volume dir. Ship a
   `docker compose` self-host path.
6. **Config surface**: `runtime.backend: kubernetes | docker | local` +
   `storage.provider: csi | btrfs | reflink | copy` + `ssh.gateway` in
   `config.schema.ts` — `kubernetes.*` becomes one backend's sub-config (the
   schema is already the right home for this).
7. **`LocalProcessBackend` / Tier 3** — only if there's still appetite.

**Why it's worth doing regardless of how far the dream goes:** steps 1–4 make
the codebase _more honest_ — backend-neutral orchestration cleanly separated
from its K8s + CSI + kernel-mount leaves — even if the Docker backend never
ships.

---

## 10. Resolved decisions & remaining follow-ups

### Resolved

- **Attach relay under Docker → mapped port per process.** Docker-native and
  simplest; no agent-side multiplexer. `resolveAgentEndpoint` yields a
  client-reachable `{ host, attachPort }` (§4.4).
- **Copy-backend quiesce → stop-then-copy for Tier 2.** Accepted _conditional_
  on the progress-surfacing workstream below (§6).
- **Prebuild artifact → CSI VolumeSnapshot when available, else OCI `tar.zst`.**
  Fastest per host; identical content key (§6).
- **Isolation off-Kata → container isolation is acceptable** at Tier 1/2. Must
  be _documented_ as the trust boundary (see follow-up) so nobody runs
  untrusted specs on Docker expecting VM isolation.
- **In-server SSH on Bun → go.** `ssh2` core is pure-JS and runs on Bun;
  `cpu-features` is an optional accelerator it skips
  ([oven-sh/bun#4290](https://github.com/oven-sh/bun/issues/4290)). In-server
  proxy is the default gateway (§5).
- **Upstream key → keep the existing shared key.** No per-sandbox keys for now.
- **SSH host key → control DB secrets store**, auto-generated once, AES-256-GCM
  at rest. Backend-agnostic + multi-replica safe; beats mounted Secret / disk
  file (§5).

### Remaining follow-ups (distinct workstreams, not blockers to step 1)

- **Backend→UI progress events** (gates Tier-2 stop-then-copy): a broad review
  of every console + CLI info surface to yield/plumb progress + loaders for
  slow lifecycle ops (pause/resume/prebuild copy). Its own effort, sequenced
  with the Docker backend.
- **Remote-SSH channel-fidelity spike:** confirm the `ssh2` proxy forwards
  `direct-tcpip` + `sftp` faithfully for VS Code / Cursor Remote-SSH and
  JetBrains Gateway (shell/exec/git/sftp/port-forward matrix). Runtime is
  resolved; only channel coverage remains.
- **Trust-boundary doc for off-Kata tiers:** write down exactly what isolation
  Tier 1/2 promises (container, not VM) and where untrusted specs must not run.
- **Deferred — per-sandbox upstream keys:** revisit only if removing sshpiper
  shifts the threat model enough to justify the blast-radius reduction.
