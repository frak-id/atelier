# Atelier v2 — A Headless Sandbox Runtime, Everything Else Is Content

Status: **proposal — v2 direction. Supersedes
[`generic-sandbox-profiles.md`](./generic-sandbox-profiles.md) and refines
[`generic-sandbox-architecture.md`](./generic-sandbox-architecture.md).**

Inputs: full manager/runtime code audits, the three research docs in
`docs/research/`, and a fresh prior-art survey of 10 sandbox platforms
(E2B, Daytona, Morph, Fly Machines, Modal, Vercel Sandbox v2, Cloudflare,
Runloop, Blaxel, Northflank) + Rivet agentOS.

---

## 0. What v1 taught us

v1 was a POC: opencode + vscode + KasmVNC baked into every sandbox, one
workspace shape for every dev, tool versions pinned in the Helm chart, a
single blessed harness, and a dashboard as the only management surface.
It proved the substrate (Kata/k3s, CSI VolumeSnapshot CoW prebuilds,
wildcard-TLS dynamic ingress, sshpiper, the Rust in-pod agent) and it
proved the demand. Everything else it proved *wrong*:

| v1 decision | Verdict |
|---|---|
| opencode/vscode/KasmVNC in every sandbox | Kill. Nothing is always-on. |
| Same workspace for every dev on a repo | Kill. Per-dev content, one substrate. |
| Tool versions hardcoded in Helm (`sharedBinaries.*`) | Kill. Versions are content, not deployment config. |
| Single harness; adding an MCP/skill = manual dashboard file edits | Kill. Harness/MCP/skills are not platform concepts. |
| Tasks/kanban/chat/session-templates | Killed already (this branch). Linear + n8n glue covers it. |
| Dashboard as the **only** surface | Kill the exclusivity, keep the primacy: API-first, GUI-primary, CLI-second (§4). |

The two intermediate proposals moved in the right direction
(profiles → fragments) but both still **semi-hardcode shapes**: typed
`mcp[]`/`skills[]`/`plugins[]` fields in one, `provides: ["harness"]`
catalog metadata in the other. And both keep the composition/policy
machinery (layers, merger, catalog, profiles) inside the same brain as
sandbox booting. v2 stops doing both.

---

## 1. The thesis

> **Atelier v2 is a self-hosted, headless sandbox runtime.** Its entire
> job is: **prebuild → boot → pause → resume → clean**, plus three live
> capabilities on running sandboxes: **file updates** (e.g. auth-key
> rotation), **supervised processes** (dev servers, any tool), and
> **URL/port exposure**. Everything else — harness, MCP servers, skills,
> vscode, a VNC browser, a company's weird internal tool with its weird
> auth dance — is **user-defined content**: files + processes + ports.
>
> Precisely: **the runtime knows only mechanism, never content.** It
> knows how to bridge a process's stdio, check a port is bound, run a
> hook on resume, enforce forward-auth on an ingress — those are
> mechanisms, and they're irreducible. What it never does is parse ACP,
> read a harness config, or model "MCP" — it cannot tell opencode from
> a cron job, and that's the discipline that keeps it from bloating.
>
> Full honesty about the surface: the five *lifecycle verbs* ride on
> two supporting capabilities the runtime also owns — **chained,
> content-addressed prebuilds** (prebuild is a verb, chaining is how it
> scales) and **warm cache volumes**. Both are storage mechanism, not
> content knowledge; they're in the runtime because they're made of
> snapshots and PVCs, which nothing above the seam can touch.

This is not a contrarian bet. The prior-art survey is unanimous: across
all 10 platforms, the primitives that survive are exactly
`{image/snapshot, env, files, processes/cmd, ports, resources, hooks,
snapshot ops}` — and **no platform types agent harness, editor, MCP
topology, or VNC as schema fields**. Platforms that tried richer typed
schemas retreated (Gitpod Classic's `vscode.extensions`/`jetbrains.*` →
gone in Flex; early E2B template types → Dockerfile escape hatch became
the main path). The typed layers that *did* win are thin annotations on
generic primitives: port numbers, health checks, resource limits,
devcontainer Features (= shell script + metadata, nothing more).

And the gaps we'd fill are real — no surveyed platform ships:
- **live env/credential push into a running sandbox** (E2B issue #1279
  is open on exactly this),
- **`onResume` rotation hooks** (only Vercel Sandbox v2 has them),
- **"sync my local agent config into a sandbox"** as a CLI primitive,
- **a self-hosted K8s+Kata runtime with these primitives at all** —
  every one of the 10 is hosted-only.

That last line is the market position: *the open, self-hostable E2B/
Daytona-class runtime, with credential rotation and local-config sync
that nobody else has.* (And why not "just use agentOS from Rivet": agentOS
is Wasm/V8 isolates — no apt, no arbitrary binaries, no persistent disk,
no real dev environment. Wrong layer for "continue my claude-code session
in a clean workspace." Rivet's own docs say so.)

---

## 2. The contract: `SandboxSpec`

One document. Fully resolved — no references, no identity, no merging
left to do. This is what the runtime accepts and the only thing it
understands. It is deliberately close to today's `config.json`
(`packages/shared/src/sandbox-config.schema.ts`), which the Rust agent
already executes.

```jsonc
// POST /v1/sandboxes
{
  "source": {                       // boot source — exactly one of:
    "image": "dev-base:1.4",        //   OCI image, or
    "snapshot": "snap_ws-frak-7f3a" //   a prebuild/pause snapshot ref
  },
  "resources": { "vcpus": 4, "memoryMb": 8192, "diskGb": 20 },

  "files": [                        // written before processes start
    { "path": "/home/dev/.claude/settings.json", "content": "…", "mode": "600", "owner": "dev" },
    { "path": "/home/dev/.config/opencode/config.json", "content": "…" }
  ],

  "env": { "GITHUB_TOKEN": "ghp_…" },   // values, already resolved

  "processes": [                    // supervised; name is the only identity
    { "name": "acp",    "command": "opencode acp", "stdio": "bridge",
      "primary": true },            // sandbox "ready"/"healthy" = this process
    { "name": "web",    "command": "bun run dev", "cwd": "/home/dev/app",
      "env": { "PORT": "5173" }, "restart": "on-failure", "after": ["acp"],
      "readiness": { "port": 5173 } },  // or { "http": "/health" } or { "cmd": "…" }
    { "name": "vscode", "command": "/opt/shared/bin/code-server --bind-addr 0.0.0.0:8080",
      "lazy": true }
  ],

  "ports": [                        // thin annotations, nothing more
    { "name": "web",    "port": 5173, "public": true },
    { "name": "vscode", "port": 8080, "public": true, "auth": "forward" }
  ],

  "hooks": {                        // arbitrary shell, phase-scheduled, ordered
    "postCreate": ["git config --global user.email dev@corp.io"],
    "postStart":  [],
    "onResume":   ["~/.atelier/refresh-tokens.sh"]   // fires on every resume
  },

  "caches": [                       // optional warm-cache volumes (see §2 prebuilds)
    { "name": "npm", "path": "/home/dev/.npm" }
  ],

  "timeoutSeconds": 86400,
  "metadata": { "workspace": "frak", "user": "alice" },  // opaque, pass-through
  "annotations": {                  // OPTIONAL display hints — see note below
    "atelier.dev/harness": "opencode",
    "atelier.dev/mcp": "linear,github"
  }
}
```

Notes on the shape:

- **No `harness`, no `mcp`, no `skills`, no `tools`, no `dev` field.**
  A harness is the `acp` process + its config files. An MCP server is a
  file in the harness's config (or a process, if stdio). A skill is a
  file. vscode is a lazy process + a port. The "browser tool" is three
  processes + a port — *declared by whoever wants it, absent otherwise*.
  The runtime cannot bloat because it has no opinion.
- **`readiness` and `primary` are the one mechanism concession — and
  they're typed on purpose.** Per-process `readiness` (`port` | `http` |
  `cmd`) is how the runtime answers "is it up" without knowing what "it"
  is; `primary: true` marks the process whose health *is* the sandbox's
  health — the generic replacement for v1's hardcoded opencode gate in
  `boot-waiter.ts`, and what `after:` waits on. Health checks are
  exactly the thin typed layer that won everywhere (K8s probes, Fly
  checks); leaving this to annotations would just get annotations read
  by machinery, which is how annotation-creep starts. The semantic label
  ("this is opencode") stays in `annotations` for display/billing; the
  mechanical fact ("gate boot on this process's port") is spec.
- **`stdio: "bridge"`** generalizes the existing ACP WebSocket bridge
  (`agent-rust/src/acp.rs`): any process can ask for its stdin/stdout to
  be relayed over a WS endpoint. The bridge is already
  protocol-transparent (a byte relay, never parses JSON-RPC) — we just
  stop naming it "acp" in the core. Same for `pty: true` (today's
  terminal). One supervisor, three attachment modes: none / stdio-bridge
  / pty.
- **`hooks.onResume` is a core primitive, not a nicety.** Physics forces
  it: pause/resume drops all network state and restores *expired*
  credentials (fastboot research §2.1, §5). Every resume needs
  re-injection. This + `PATCH /files` below is the rotation story.
- **`ports` stay thin.** `{name, port, public, auth?}`. Hostname pattern
  `{name}-{sandboxId}.{domain}` (the multi-dev-servers routing analysis
  carries over unchanged), plus `/proxy/{port}` as the zero-declaration
  escape hatch. No service types, no protocols, no LB config.
- **`metadata` is opaque.** The runtime threads it through for
  observability and never reads it. This is how E2B/Fly keep tenancy out
  of the compute path.
- **`annotations` are display hints, never behavior.** The runtime never
  reads them either; clients that *compose* a spec are encouraged to tag
  what they composed (`atelier.dev/harness: opencode`) so the dashboard
  can render "opencode with the linear MCP" instead of just "a process
  named acp". Untagged specs render generically and work identically.
  This is the Fly-labels/K8s-annotations compromise: structured
  introspection without a typed schema anything *depends* on — and
  since the GUI is the primary experience (§4), compose always writes
  them: the GUI's semantic display is only as good as its clients'
  tagging discipline, which is one more reason composition flows
  through one SDK.
- **Attach: one named writer, read-only fan-out.** Decided, since it's
  public API: a stdio-bridge has at most one writer at a time (first
  attach with `mode=rw` holds it; explicit takeover releases it); any
  number of `mode=ro` attaches stream output with ring-buffer replay.
  PTY attach keeps today's replay model. Note this is *policy to build*,
  not current behavior — today's `acp.rs` has no concurrent-writer
  guard; two writers would interleave corrupt frames.
- **Secret references have one syntax.** Specs at rest use
  `{"$secret": "NAME"}` as a value in `env` or `files[].content`
  (JSON-typed, greppable, impossible to half-interpolate — unlike
  `${…}` string templating). Control substitutes them at the seam; the
  runtime rejects any spec still containing one.

### Runtime API (the whole thing)

```
POST   /v1/prebuilds                  { source, files, env, build[] } → snapshotRef
                                      // source = image OR another snapshotRef → prebuilds CHAIN
                                      // idempotent: keyed by content hash; hit = instant return
POST   /v1/sandboxes                  SandboxSpec → { id, urls }
GET    /v1/sandboxes/:id              status, urls, processes (+ readiness), generated
                                      // create response returns runtime-generated values
                                      // (agent password, pod IP, per-sandbox tokens) under
                                      // `generated` — see "mid-boot values" in §6 phase 1
POST   /v1/sandboxes/:id/pause        → snapshot, release compute
POST   /v1/sandboxes/:id/resume       { files?, env? } → runs onResume hooks
DELETE /v1/sandboxes/:id              full clean (label-selector teardown, exists today)

PATCH  /v1/sandboxes/:id/files        [{ path, content, mode? }]        // live push
PATCH  /v1/sandboxes/:id/env          { KEY: "value" }                   // re-exported to new processes + hook
POST   /v1/sandboxes/:id/processes    { name, command, … }               // ad-hoc supervised process
POST   /v1/sandboxes/:id/processes/:name/{start|stop|signal}
GET    /v1/sandboxes/:id/processes/:name/logs
POST   /v1/sandboxes/:id/ports        { name, port, public }             // expose after boot
POST   /v1/sandboxes/:id/exec         one-shot command (exists today)
WS     /v1/sandboxes/:id/attach/:name stdio-bridge / pty attach
POST   /v1/sandboxes/:id/snapshot     promote current disk → snapshotRef
```

`resume` accepting `{files, env}` inline is the fix for the industry gap
(E2B #1279): rotate credentials *as part of* resuming, atomically, before
processes restart — the clean case, since everything restarts anyway.
For **running** sandboxes, semantics are stated honestly (no platform
does live env injection into a live process, and we won't pretend to):
`PATCH /env` affects (a) future process spawns and (b) fires an
`envChanged` hook the user wires to reload/SIGHUP their processes; it
does **not** mutate a running process's environment. File-based rotation
(`PATCH /files` + a re-reading process, or the hook) is the primary
running-sandbox path — exactly how auth-file rotation works today, now
through the front door.

### Prebuild economics (unchanged, now enforced by the contract)

The fastboot research rules are physics; the spec encodes them
structurally:

- **Snapshot key = hash(source ⊕ prebuild files ⊕ build[] ⊕ repos).**
  Runtime content (files/env/processes/ports/postStart hooks) never
  enters the key. One workspace snapshot serves every dev — no
  O(devs × configs) matrix. A spec that needs baked system packages is
  simply a *different prebuild* (slow once, instant after).
- **Boot overlay budget ≈ 500ms:** file writes, env injection, process
  spawn — fine. `npm install` at boot — no; that's a prebuild. Binaries
  a process references must be pre-staged (in the snapshot, or on the
  shared read-only catalog volume `/opt/shared` — mechanism we keep, but
  its *contents* become deploy-time/user-managed artifacts, not
  Helm-pinned `opencode@1.16.2`).

### Layered prebuilds: personalization that isn't cheap

Not all personalization is a file write. Installing pi or an opencode
plugin often triggers npm downloads under the hood — the very thing the
v1 `opencode-warmup` prebuild step papered over for one hardcoded
harness. v2 generalizes it instead of special-casing it:

1. **Prebuilds chain.** `POST /v1/prebuilds` takes `source: image |
   snapshotRef`, so a dev's expensive setup is a *derived snapshot on
   top of* the workspace snapshot:

   ```
   dev-base image ─▶ workspace snapshot ─▶ alice's pi+plugins snapshot
        (org)            (repos + deps)         (build: ["curl … install pi",
                                                          "pi install my-plugin"])
   ```

   Booting from the derived snapshot makes the expensive steps cost
   zero at spawn. This is Morph Infinibranch's cached-prefix model and
   Docker layer caching at the VM level.
2. **Content-addressed, so no matrix — with an honest asterisk.** The
   derived key is `hash(parent key ⊕ build[] ⊕ files)` — keyed on
   *what is built*, never on who asked. Two devs with identical pi
   setups resolve to the same snapshot; a company preset baked once
   serves the whole team. But dedup only collapses *identical* setups:
   genuinely distinct per-dev plugin sets are still O(devs) snapshots.
   What keeps that safe is that each is **opt-in** (the client decides
   what's worth baking), **evictable** (GC; an evicted layer rebuilds
   on next request, slow once), and **reproducible** (the spec fully
   determines the snapshot, so eviction is always safe).

   ⚠ **The real risk is node-locality, not count.** TopoLVM snapshots/
   PVCs are node-local; workspace prebuilds already pin sandboxes to a
   node. Per-dev derived snapshots *multiply* node-pinned objects:
   Alice's baked layer lives on node A — node A full or drained → her
   "instant" boot silently regresses to a cold rebuild, i.e. the
   fast-boot promise breaks exactly for the power users who invested in
   baking. Consequence for sequencing: **chained prebuilds ship
   team-scoped first** (company presets, workspace-level derived
   layers — few objects, high reuse); opening per-dev baking to
   everyone is gated on a **placement/GC spike** (capacity-aware
   snapshot placement or cross-node copy, rebuild-on-miss UX, eviction
   policy) — a real design task, not an LRU threshold to tune.
3. **Warm caches as the middle tier.** Some cost sits between "bake it"
   and "run it at boot": package-manager caches (`~/.cache/opencode/
   packages`, npm store, cargo registry). An optional **cache volume**
   (`caches: [{ name: "npm", path: "~/.npm" }]` in the spec) — a small
   per-key PVC mounted rw and persisted across that key's sandboxes —
   turns a cold `pi install xx` into a warm one without any snapshot at
   all. This subsumes v1's warmup: it was exactly "pre-warm one
   hardcoded cache dir"; now it's a generic primitive any spec can use.

The CLI makes the choice ergonomic, not architectural:
`atelier up --bake` = "hash my spec's build steps; if a derived snapshot
exists, boot from it, else build it first (or in background while I boot
the slow way once)." The runtime only ever sees chain-of-prebuilds +
boot-from-snapshot — no new concepts.

### Ordering: arrays and phases, not a DAG

Interdependent setup steps ("install pi, *then* `pi install xx`") need
no dependency system:

- **Within a phase, arrays are ordered.** `build[]` and each `hooks.*`
  list run sequentially, fail-fast — same as v1 `initCommands`, same as
  Gitpod tasks and devcontainer lifecycle commands. Step 2 can always
  assume step 1 completed.
- **Across phases, order is fixed:** `build[]` (bake) → files/env →
  `postCreate` → processes → `postStart` → (…run…) → `onResume` on each
  resume. If "install pi" was baked and "pi install xx" runs at
  `postCreate`, the ordering is automatic — bake always precedes boot.
- **Across chained prebuilds,** the parent snapshot is complete before
  the child's `build[]` starts, by construction.
- **Processes** get one thin ordering affordance: optional
  `after: ["name"]` waits for the named process's readiness (port-bind
  or liveness) before spawning. That covers "dev server needs the db up"
  without importing a DAG scheduler; anything fancier belongs in the
  user's own entrypoint script.

A standing guard against surface creep: the process model is now
`readiness` + `primary` + `after` + `restart` + `lazy` — each one maps
1:1 to an accepted industry primitive (K8s probes, K8s init ordering,
restart policies, lazy activation à la socket-activation). **That
mapping is the admission bar**: any future process-orchestration field
must point at a known primitive from K8s/Fly/systemd-units-as-consumed-
by-platforms, or it doesn't go in — otherwise "the runtime knows only
mechanism" erodes one convenient field at a time until the agent is a
bespoke systemd.

---

## 3. Three layers, one seam

```
┌─ CLIENTS ──────────────────────────────────────────────────────────────┐
│  web GUI (primary:    atelier CLI               your scripts / CI /    │
│  spawn/monitor/admin) (power users, sync, CI)   n8n / Linear glue / … │
│        │  all composing via @atelier/compose — ONE shared SDK:         │
│        │  harness composers, presets, spec merge, sync manifests       │
└────────┼───────────────────────────────────────────────────────────────┘
         │  SandboxSpec (+ auth token)
┌─ CONTROL (thin, stateful) ─────────────────────────────────────────────┐
│  authn (API keys — already exist: atl_*), quotas, saved specs          │
│  ("workspaces" = named spec templates), secrets store (values resolved │
│  here, injected into the spec, never stored in it)                     │
└────────┼───────────────────────────────────────────────────────────────┘
         │  resolved SandboxSpec — THE SEAM (typed module boundary today,
         │  network API when a second caller/BYOC appears)
┌─ RUNTIME (headless, mechanism only) ───────────────────────────────────┐
│  prebuild · boot · pause · resume · destroy                            │
│  files · env · processes · ports · hooks · exec · attach               │
│  knows only mechanism (bridge/probe/hook/route) — never content:       │
│  no users/orgs/workspaces; never parses ACP or a harness config        │
│  substrate: Kata/k3s · CSI snapshots · ingress · sshpiper · Rust agent │
└────────────────────────────────────────────────────────────────────────┘
```

Three deliberate choices:

1. **Composition happens in the client — through one shared SDK.** This
   is the biggest break from the profiles/fragments proposals. There is
   no server-side layer merger, no fragment catalog, no
   `provides/requires` resolution. A "dev profile" is whatever a client
   assembles into a spec before calling the API. devcontainers proved
   the shape: the spec is a file, the platform executes it, composition
   (Features) is client-side tooling. (Honest caveat: devcontainer.json
   keeps some typed fields — `forwardPorts`, `customizations.vscode.*`;
   v2 keeps only ports/resources/readiness typed, which is where all 10
   surveyed platforms landed.)

   Be honest about what this move buys: **the runtime gets much simpler;
   the clients get fatter; net system complexity is roughly conserved.**
   The win isn't "less code", it's *where* the complexity lives — out of
   the boot path, versionable, forkable, and off the deployment's
   critical surface. To stop that relocated complexity from drifting
   across CLI/dashboard/MCP/company scripts, it lives in **one place:
   `@atelier/compose`**, a first-class TypeScript library
   (`packages/compose`) that every client imports. It owns:
   - the **harness composers** (today's `harness-adapter.ts` +
     `opencode-*.ts` knowledge: which config files, what paths, what
     launch flags — "opencode with these MCP servers" → files + the acp
     process + annotations),
   - the **preset snippets** (today's `BUILTIN_TOOLS`: vscode, browser,
     terminal — each a function returning spec pieces),
   - the **spec-file merge** (repo `atelier.jsonc` ⊕ user overlay ⊕
     flags — defined once here, not an open question: deep-merge,
     arrays merged by `name`/`path`, last layer wins, same rules as the
     old profile merger but running client-side),
   - local-config **sync manifests** (which paths `atelier sync
     ~/.claude` actually walks).

   Dashboard, CLI, and MCP tools all call the same functions; a company
   wrapper script imports the same package. Shareable presets remain
   devcontainer-Feature-thin — a function + metadata emitting spec
   pieces — versioned in git, zero server machinery.
2. **Control stays, but shrinks — and does exactly two spec mutations.**
   The critique says "stop mixing orgs with booting" — correct — but a
   trust boundary above the runtime is unavoidable (E2B's API layer does
   auth/quota/billing and the orchestrator "implicitly trusts" it). Keep
   it thin: authn, quota, secret values, saved specs. At the seam
   crossing, control performs **bounded spec enrichment** and nothing
   else: (a) **secret resolution** — replace secret *references* with
   values; (b) **org-policy injection** — append operator-mandated
   entries (an audit process, a compliance file) from a per-org policy
   spec. That second one is the team-enforcement answer: a dev
   hand-crafting a spec against the raw API still gets the mandated
   pieces, because enrichment happens server-side on every crossing. No
   merger, no catalog, no fragment resolution — two append/substitute
   steps, deterministic, tiny. Org/RBAC richness can grow in this layer
   later without ever touching the runtime — Coder shows that's a
   legitimate *product*, in its own layer.
3. **One deployable, three modules — for now.** CP research is emphatic:
   Fly/E2B/Nomad extracted their low-level API *after* the product
   proved its shape. The seam is `runtime.create(spec)` as a function
   signature that policy code cannot reach past. We extract it into a
   separate service when a real second caller exists, not before.

### 3.1 The server: what replaces the "manager"

**The name "manager" retires with v1** — it names the mixed-everything
brain this whole proposal exists to unmix. The v2 deployable is
`apps/server` ("the Atelier server"), one process, **three internal
modules** with import boundaries enforced by package structure, not
convention:

```
apps/server
├─ runtime/    MECHANISM.  prebuild/boot/pause/resume/destroy · files/env/
│              processes/ports/hooks/exec/attach · kube builders · CSI
│              snapshots · ingress · sshpiper pipes · agent client.
│              Tables: sandboxes(id, spec, status, generated, metadata),
│              snapshots(hash, parent, ref), catalog. NO import of
│              control/ or sessions/; no FK to any identity table —
│              callers are just "authenticated principals" to it.
├─ control/    POLICY.  Everything identity-shaped lives here and ONLY
│              here: users · orgs · org-members · GitHub OAuth · API keys ·
│              SSH keys · GitHub-token resolution · quotas · secrets store ·
│              saved specs · org policy specs · cliproxy key/provider policy ·
│              credential-rotation schedules · prebuild staleness watching.
│              Performs the two enrichment steps at the seam, then calls
│              runtime.*(spec). Imports runtime/'s interface; never its
│              internals.
├─ sessions/   AGENT APP-TIER.  The ACP client + session facade
│              (agent-dispatch.ts, acp-stream.ts, agent-facade routes:
│              sessions/prompts/questions/SSE events). Parses ACP — i.e.
│              CONTENT — so it is banned from runtime/; but it must be
│              server-side because the founding flow demands it: your
│              phone can't hold a WebSocket to a sandbox for six hours,
│              so something durable consumes the ACP stream via the
│              attach bridge, persists events, and holds permission
│              prompts until you look at your phone. Architecturally a
│              privileged CLIENT of runtime (attach + files, same API
─              anyone could use) that happens to ship in the box.
└─ api/        HTTP shell: /v1/* → runtime (through control's authn +
               enrichment) · /api/* → control CRUD · /sessions/* →
               sessions · /mcp → same three.
```

Where the v1 concepts land, by name:

| v1 concept | v2 home | What changes |
|---|---|---|
| Users, orgs, org-members, GitHub OAuth | `control/` | Unchanged in function; now structurally unable to touch boot code. |
| **Workspace** | **Dies as a concept, survives as data**: a `saved_spec` row in `control/` | `{name, orgId, spec, policyRefs}` — a named, shared, spawnable spec template. "Workspace definition" = editing a saved spec. Repos, initCommands, resources: all just spec fields now. |
| API keys, SSH keys, GitHub tokens | `control/` | SSH public keys resolve → a `files` entry (`authorized_keys`) during enrichment; the sshpiper *Pipe CRD* stays runtime (mechanism). |
| Config-files module (dashboard-edited opencode.json etc.) | Dies as a module | Its content becomes ordinary `files` entries in saved specs, composed via `@atelier/compose`. |
| CLIProxy key minting / provider policy | `control/` (policy) | The derived key lands in the spec as env/files at enrichment; runtime never knows what cliproxy is. |
| Auth-sync cross-sandbox credential broadcast | `control/` rotation schedules | Becomes `PATCH /files` calls against affected sandboxes — through the front door. |
| Agent facade / opencode session surface | `sessions/` | Generalized to ACP-over-attach; opencode-specific HTTP client dies with v1. |
| Prebuild runner + staleness checker | Split | Pod/PVC/snapshot mechanics → `runtime/`; "which saved specs should rebuild when" → `control/`. |

Two boundary rules that keep this honest: **runtime/ compiles without
control/ or sessions/** (a build-level check, the future extraction
seam — lift `runtime/` + `api/v1` out and it's the headless service);
and **sessions/ talks to sandboxes only through the runtime API**
(attach bridge + files), never through private channels — so the day a
company wants their own agent orchestrator instead of ours, they
replace `sessions/`, not the platform.

---

## 4. API-first, GUI-primary, CLI-second

Get the ordering right, because v1 got it wrong in *both* directions:
the dashboard was the **only** surface (bad — no automation, no config
portability, manual file edits to add an MCP server), but the dashboard
is also **why Atelier exists**. The founding flows are GUI flows:

- **Launch-and-walk-away.** A dev spins up agent tasks from the web
  GUI, goes on a walk / to bed / on vacation, and monitors from their
  phone. Attach to the session, check the diff, answer a permission
  prompt — from mobile. No CLI will ever serve this.
- **The non-technical consumer.** A product person logs into a sandbox
  someone in DevOps baked for them — opencode + vscode + the VNC
  browser + the company's repos, everything ready — and prototypes,
  interrogates the codebase, experiments, without ever filing a ticket
  to engineering. They will never install a CLI, and they shouldn't
  have to. This is the small/mid-team superpower.

So the rule is **API-first, not CLI-first**: every capability exists as
an API call before any surface exposes it — *if a flow can only be done
through the dashboard, the API is wrong* — but the **web GUI is the
primary product experience** and gets designed as such (mobile-first
monitoring, one-tap spawn from saved specs, live session view over the
attach bridge), with the CLI as the second, power-user/automation
surface. Both are thin clients over the same `/v1` API + the same
`@atelier/compose` SDK, so "GUI-primary" costs the architecture
nothing — it's a product-investment ordering, not a coupling decision.

What the GUI must do well (the v2 rewrite of the dashboard):

- **Spawn without composing:** pick a saved spec (or a preset like
  "full workstation: opencode + vscode + browser") → one tap → running.
  Composition already happened — by the operator who saved the spec, or
  by `@atelier/compose` presets. The product person never sees JSON.
- **Mobile monitoring:** sandbox list with `primary`-process health,
  live session stream (read-only attach over the stdio-bridge — the
  `ro` fan-out mode is *designed for this*), permission prompts
  surfaced as push-able events, diff summaries.
- **Semantic display via annotations:** "opencode running, linear +
  github MCP" — which is why annotations are in the spec (§2) and why
  compose always writes them.
- **Operator console:** fleet status, saved-spec management, org policy
  spec, quotas, catalog — the platform-team half (§8).

The CLI remains the reference client for *the API's completeness* and
owns the flows a GUI can't: local-config sync, scripting, CI. Auth
already works for it (`POST /api-keys` → `Authorization: Bearer atl_…`).

```bash
atelier prebuild ./atelier.jsonc                 # substrate → snapshot
atelier up --spec ./atelier.jsonc                # boot from spec file
atelier up --from-snapshot ws-frak               # boot from prebuild
atelier up --bake                                # bake my build[] into a derived
                                                 # snapshot (content-hash keyed),
                                                 # instant on every later up

# the killer flow nobody else ships — replicate local agent setup:
atelier sync ~/.claude       sb_7f3a:/home/dev/.claude
atelier sync ~/.config/pi    sb_7f3a:/home/dev/.config/pi
atelier attach sb_7f3a acp                       # continue the session there

atelier pause sb_7f3a
atelier resume sb_7f3a --env GITHUB_TOKEN=$(gh auth token)   # rotate on resume
atelier ps / logs / exec / expose / snapshot / rm
```

`atelier sync` is `PATCH /files` + a local diff walk. `atelier attach`
is the WS stdio-bridge. Both are trivial over the v2 API and impossible
to express cleanly over v1's workspace-shaped API — which is the point.

The manager's existing MCP server gets the same treatment: today it's
read-mostly introspection; it grows the mutation tools
(create/pause/resume/rm/files/expose) so agents drive sandboxes exactly
like the CLI does. One API, three surfaces — GUI (primary), CLI, MCP.

---

## 5. Mapping v1 code to v2 (what to copy, what to reshape, what to drop)

v2 is built on a parallel track (§6), so this table reads as a
**harvest list**, not an in-place refactor plan: the audits found ~80%
of the substrate worth carrying over; the coupling is concentrated at
entry points, which simply don't get copied.

| Today | v2 role | Work |
|---|---|---|
| `orchestrators/kernel/*` (boot/cleanup) | Runtime core | Narrow inputs: kill the `Workspace` param; take `SandboxSpec`. `finalizeNewSandbox`'s `sandboxHasDev` workspace lookup goes away (ports are in the spec). |
| `orchestrators/kernel/boot-waiter.ts` | **Delete** | Hardcoded opencode `/health` readiness gate. Replaced by the spec's typed `readiness` probes + `primary` health. The runtime must not know what opencode is. |
| `orchestrators/tools/registry.ts` `BUILTIN_TOOLS` | **Demote to `@atelier/compose` presets** | The declarations (command, port, exposure) become spec snippets every client offers ("add vscode" = append 1 process + 1 port). Ingress-building half moves into the runtime's `ports` handling. `core: true` opencode dies. |
| `orchestrators/sandbox-config.ts` (`buildSandboxConfig`) | Absorbed | The spec *is* the config. `generateSandboxMd` becomes an optional client-side file. |
| `orchestrators/prebuild-runner.ts` | Split | Pod/PVC/VolumeSnapshot mechanics → runtime `prebuild(spec)`. Workspace-config reading, `resolveGitHubToken`, opencode warmup → control/client side (they become `files` + `hooks.build[]` in the prebuild spec). Staleness checker keys on the substrate hash. |
| `orchestrators/workflows/*` (create/restart) | Rewritten thin | Today they interleave policy calls (`users.resolveGitHubToken`, `internal.syncAllToSandbox`, `cliproxy.ensureSandboxKey`) with boot steps. v2: control resolves all of that *into the spec first*, then calls `runtime.create(spec)` once. |
| `SandboxPorts` DI bag | Split in two | Mechanism deps (AgentClient, SandboxRepository, Kube) vs policy deps (User/Workspace/ConfigFile/CLIProxy/Internal services). Runtime code can only import the first. |
| `shared/agent/agent-dispatch.ts`, `acp-stream.ts` | Keep (client layer) | Already harness-neutral ACP plumbing; sits above the seam, talks to the generic stdio-bridge. |
| `shared/agent/harness-adapter.ts`, `shared/lib/opencode-*.ts`, `opencode-warmup.ts` | Move into `@atelier/compose` | Adapters become spec composers: "opencode with these MCP servers" → emits files + the acp process + annotations. Harness config formats never cross the seam — and live in exactly one package. |
| `modules/config-file`, `modules/cliproxy`, `modules/internal` (auth-sync) | Control layer | Their outputs become `files`/`env` entries in specs. `auth-sync`'s cross-sandbox credential broadcast becomes: control calls `PATCH /files` on affected sandboxes — same behavior, through the front door. |
| `agent-rust` | Extend (phase 1, load-bearing) | Config mutability (kill the `LazyLock`), agent-side autostart + phased hooks, ad-hoc process registration, generic N-port forwarder, unified attach bridge with single-writer guard, `readiness`/`primary` probes. See migration phase 1 — the seam depends on this, not the reverse. |
| `infra/images/dev-base` | Slim | KasmVNC/chromium/openbox out of the base (they're content; a preset's prebuild bakes them for the ~2 teams that want them). Fix the `values.yaml ports.agent: 9999` vs actual `:9998` drift while we're there. |
| Helm `sharedBinaries.*` versions | **Delete** | Catalog contents managed via API/CLI (an admin job populating `/opt/shared`), not chart values. |
| Dashboard | **Rewrite as the primary product** (§4) | Two faces: dev/consumer (one-tap spawn from saved specs & presets, mobile-first monitoring, live read-only session view, permission prompts, annotation-driven semantic display) and operator (fleet, saved/policy specs, quotas, catalog). Composition via `@atelier/compose` presets — "add vscode" = append a preset snippet, same function the CLI calls. Spec editor for power users; no per-tool bespoke forms. |

Killed in this branch already and staying dead: tasks/kanban, chat,
session-templates. External glue (Linear ↔ n8n/ActivePieces → CLI/MCP)
covers orchestration wants.

---

## 6. Build plan: parallel track, not in-place surgery

**Decision: v2 is developed *beside* v1, not on top of it.** New
packages and apps (`apps/server` with its three modules (§3.1) +
`packages/spec`, `packages/compose`, a v2 agent line), with v1 code
**copied in and reshaped** where it earns it (K8s resource builders,
snapshot machinery, ingress/sshpiper wiring, the agent's supervisor/
bridge/PTY code) and merely *inspiring* the rest. v1 keeps running
untouched — the founding flows (spawn from dashboard, walk away,
monitor from phone; the product team's baked sandboxes) never regress
because their code path literally doesn't change.

Why parallel wins over in-place here:

- It **dissolves the big-bang risk** an in-place phase 1 had: rewriting
  the agent's config loading (`LazyLock`), autostart, and attach bridge
  inside the live boot path could only "keep prod working" if every
  change was painstakingly additive/flag-gated. On a parallel track the
  constraint disappears structurally: the agent ships baked into
  sandbox images, so the **v2 agent line evolves freely in v2 images**
  while every v1 sandbox keeps the v1 agent it booted with. Same for
  the manager: no compatibility shims, no behavior-diff gates against
  the old workflows, no `-v2` suffixed functions threaded through v1
  call sites.
- The audits' "~80% reusable" claim gets tested honestly: reusable
  code is *copied and reshaped* against the new contracts instead of
  contorted in place around old ones. Where only the philosophy
  survives (tool registry → compose presets; prebuild runner →
  `prebuild(spec)`), we rewrite without archaeology.
- Cutover becomes a **per-user/per-workspace choice**, not a
  deployment event: both stacks run against the same cluster
  (namespaced/labeled apart), a workspace's owner flips it to v2 by
  saving its spec, and v1 is deleted when its sandbox count hits zero.

The cost, stated: temporary duplication (two managers, two agent
images, double deploy surface for a while) and drift risk for anything
fixed in v1 during the window — acceptable because the window is
bounded and v1 is feature-frozen (bugfix-only) from day one.

Milestones (order = dependency order; each lands on the v2 track):

0. **Contracts + data mapping (design, cheap).** `SandboxSpec` +
   prebuild spec in `packages/spec`. Mid-boot generated values decided:
   runtime-created values (agent password, pod IP, derived tokens)
   return under `generated` in the create response — the spec stays
   pure input. Map v1 rows forward: a `Workspace` compiles to a **saved
   spec**; sandbox rows keep `workspaceId` as opaque `metadata`;
   prebuild snapshots re-key to the substrate hash via a one-time
   alias.
1. **v2 agent.** Fork the agent crate: keep supervisor/exec/files/PTY/
   bridge code, then build what the spec needs — mutable watched config
   (no `LazyLock`), agent-side autostart + phased hooks, `readiness`
   (`port`/`http`/`cmd`) + `primary` health, unified attach bridge
   **with the single-writer guard** (missing in `acp.rs` today —
   concurrent writers corrupt the stream), generic N-port forwarder.
   Ships in v2 images only; v1 sandboxes never see it.
2. **v2 runtime module** (`apps/server/runtime`). Copy/reshape kernel
   boot/cleanup, kube resource builders, snapshot machinery against
   `SandboxSpec`. No `Workspace` anywhere; no policy imports (enforced
   by package boundary — `runtime/` must compile alone). The known v1
   leaks (`sandboxHasDev`, `sshKeys.getValidPublicKeys` in boot,
   `InternalService` holding the AgentClient) simply don't get copied.
   `/v1/*` routes on top, existing `atl_` API-key auth.
3. **Control + sessions + compose + CLI.** `control/` (identity, orgs,
   quotas, saved specs, secrets, the two enrichment steps — §3.1);
   `sessions/` (ACP facade over the attach bridge — the phone-
   monitoring backend); `packages/compose` (harness composers from
   `harness-adapter.ts`/`opencode-*.ts` knowledge, presets from
   `BUILTIN_TOOLS`, spec merge, sync manifests). `atelier` CLI:
   up/pause/resume/rm/sync/attach/expose. MCP mutation tools. **First
   real v2 users here** (CLI early adopters), while v1 serves everyone
   else.
4. **Prebuild + catalog.** `prebuild(spec)` with substrate-hash keying
   and chaining; `atelier catalog add … --sha256 …` replacing the Helm
   shared-binaries job (checksum verification closes the existing
   supply-chain TODO). Prerequisite for "select a harness at boot"
   being spawn-not-install.
5. **GUI v2 (the primary product, §4).** Built against the v2 API from
   scratch, reusing v1 dashboard components where they fit: one-tap
   spawn from saved specs, mobile-first monitoring, live session view
   over the `ro` attach fan-out, permission-prompt events, operator
   console, spec editor. **General cutover happens here** — workspaces
   flip as owners save their specs.
6. **Decommission v1** when its sandbox count is zero: delete the old
   workflows/registry/boot-waiter, the v1 agent line, the compatibility
   alias table. *(Runtime extraction as a separate deployable still
   waits for a real second caller — unchanged.)*

---

## 7. Non-goals / discipline

- **No server-side fragment catalog, layer merger, or profile objects.**
  Composition is client tooling. If preset sharing needs server help
  later, it's a dumb blob store, not a resolver.
- **No plugin SDK, no marketplace, no warming machinery** until real
  third-party presets exist.
- **No second deployable now.** Seam = typed module boundary.
- **No agent orchestration in the runtime.** ACP session facades,
  permission brokering, multi-agent dispatch — legit products, all above
  the seam, possibly a separate app entirely.
- **Secrets never live in specs at rest.** Control stores values; specs
  are safe to commit with references; resolution happens at the seam
  crossing, values exist only in the ConfigMap/env of a booted sandbox.
- **Trusted-operator security model, stated honestly.** Specs contain
  arbitrary shell (hooks) and the agent has no path allow-list; Kata is
  the isolation boundary between sandboxes, the control layer is the
  boundary between users. Same as today — but now it's written down.

---

## 8. Who is this for, and where does gravity live

Two strategic questions the architecture doesn't answer by itself,
answered explicitly so they're decisions rather than drift:

- **One buyer, three users.** The buyer is a platform team / the tech
  lead of a small-mid company (someone Coder-adjacent installs and
  operates Atelier: Helm, nodes, catalog, org policy). The users are:
  1. **the dev** — launches agent tasks from the GUI, walks away,
     monitors from their phone; drops to the CLI for local-config sync,
     scripting, per-dev baked snapshots;
  2. **the non-technical teammate** — product/design person logging
     into a fully-baked sandbox (harness + vscode + VNC browser + the
     company repos) that the operator spun up from a saved spec;
     prototypes and interrogates the codebase without ever pinging
     engineering. GUI-only, by definition;
  3. **the operator** — fleet console, saved/policy specs, quotas,
     catalog.
  Consequence: the **web GUI is the primary product** (§4) serving all
  three; the **CLI is the completeness proof and the power surface**.
  Note how persona 2 leans on the machinery above the seam: a "baked
  sandbox for the product team" is exactly *saved spec (operator) +
  compose presets + policy enrichment* — no new concepts, just the
  existing ones pointed at a non-dev consumer.
- **Gravity is deliberate, and it isn't the runtime.** A spec is a
  portable JSON file — by construction there is no runtime lock-in,
  and as an open-source infra play that's a feature: it's *why* a
  platform team can adopt it without a bet-the-company decision. The
  retention centers are above the seam, on purpose: the org's **saved
  specs + policy specs + secrets** in control (operational gravity),
  the team's **prebuild/cache investment** (performance gravity), and
  **`@atelier/compose` + preset ecosystem** (workflow gravity). If a
  hosted product ever exists, it's control-plane-as-a-service over the
  same runtime — the seam is the product line.

---

## 9. Open questions

1. **Spec file name & format** — `atelier.jsonc` vs TOML; repo-local
   checked-in + user-local overlay (merge semantics are settled — they
   live in `@atelier/compose`, §3.1); just the surface syntax to pick.
2. **Pause fidelity** — v1 "pause" = pod delete + PVC keep (disk-only,
   cold-ish resume). Memory snapshots (CRIU/Kata snapshot) are the Morph
   /Blaxel-class differentiator — worth a spike, not a blocker.
3. **Per-org catalog volumes** — is one cluster-wide `/opt/shared`
   enough, or do orgs need their own staged-binary volumes?
4. **Snapshot placement/GC spike design** — the gate for per-dev baking
   (§2, layered prebuilds): capacity-aware placement or cross-node
   snapshot copy, rebuild-on-miss UX, eviction policy for derived
   layers and cache volumes. Scoped as a design spike, not a tuning
   knob.
5. **Auth for the runtime API when extracted** — API keys are per-user
   today; a service-account/machine-token concept will be needed for CI
   callers.
