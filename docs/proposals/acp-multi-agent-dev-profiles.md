# ACP Multi-Agent + Dev Profiles

Status: **proposal — agreed direction, not yet implemented**

A strategic pivot for Atelier: stop shipping one blessed AI stack (OpenCode) and
instead make the **coding agent a per-developer choice** driven through a single
standardized protocol — the [Agent Client Protocol (ACP)](https://agentclientprotocol.com).
Each dev brings their own harness (pi, Claude Code, opencode), their own MCP
servers, skills, and dotfiles, via a portable **Dev Profile** — while the
sandbox substrate (Kata pods, snapshots, ingress, SSH, auth-sync) stays exactly
as it is.

This document is the full design: goals, architecture, UX, the fast-boot
strategy, the keep/refactor/delete map, tradeoffs, and a phased rollout.

---

## 1. Goal

Today the unit of customization is the **project**: one standardized stack with
per-workspace tool overrides. But developers don't converge on a stack — they
diverge. One wants pi with a custom extension set; another wants Claude Code;
another opencode. They want to try a new MCP server, a new skill, a new harness
on a real task **this afternoon**, and see whether it actually helps.

The pivot moves the unit of customization from `project` to `(project × developer)`:

- **Project layer** (shared, unchanged): repos, init commands, dev server,
  secrets, resources, prebuild snapshot.
- **Dev profile layer** (per developer, portable): agent harness, model, MCP
  servers, skills, dotfiles, editor — layered on top of the project at spawn.

The unifying mechanism is **ACP**: Atelier becomes an ACP *client* (orchestrator),
and any ACP-compatible agent runs inside the pod as an ACP *agent*. This is the
LSP-for-agents bet — implement the client once, support the whole ecosystem.

### Success criteria

1. A workspace can be run by pi, Claude Code, **or** opencode with no code change —
   only a profile change.
2. A developer can add/swap an MCP server or skill in **two clicks** (catalog) or
   one config-file edit, and try it on a real task without rebuilding an image.
3. Boot stays **< 10 s** to fully-ready (harness initialized, MCP servers
   connected, non-lazy tools up — nothing lazy on the hot path).
4. The kanban / attention / multi-session orchestration value survives, now
   agent-agnostic, fed by the uniform ACP event stream.
5. Running the **same task across N harnesses** and comparing them (time, tokens,
   cost, outcome) is a first-class flow.

### Non-goals

- Replacing the substrate (Kata/k3s/TopoLVM/sshpiper/ingress) — kept as-is.
- Supporting non-ACP agents. If it doesn't speak ACP (natively or via adapter),
  it's not in scope.
- Reimplementing a per-agent SDK surface. ACP is the only integration contract.

---

## 2. Background: what's coupled to OpenCode today

OpenCode is currently load-bearing in three places. (Full file-level map in
[Appendix A](#appendix-a--keep--refactor--delete-map).)

1. **Tool registry** — `apps/manager/src/orchestrators/tools/registry.ts` marks
   `opencode` as the one `core: true` tool, always started, even for workspaceless
   sandboxes. The command is a hardcoded `opencode serve …`.
2. **Task/session pipeline** — bound to `@opencode-ai/sdk/v2`:
   - `apps/manager/src/shared/lib/opencode-{client,session,sse,auth}.ts`
   - `apps/manager/src/orchestrators/{task-spawner,opencode-warmup}.ts`
   - `apps/manager/src/orchestrators/kernel/boot-waiter.ts`
3. **Dashboard** — `apps/dashboard/src/api/opencode.ts` and the kanban /
   attention / sessions UI consume OpenCode SDK types (`Session`, `Todo`,
   `PermissionRequest`, `QuestionRequest`) directly.

The good news, confirmed by the recon: the **substrate is already
agent-agnostic**. The Rust in-pod agent (`apps/agent-rust`) only reads service
commands from `config.json` and runs them — it doesn't know what OpenCode is.
Config-file/secret replication and auth-sync are generic file-push machinery.
The coupling is concentrated and mappable, not pervasive.

---

## 3. ACP, grounded

Key facts from the spec and ecosystem research that shape the design
(citations in [Appendix B](#appendix-b--references)):

- **Sessions**: `session/new` takes `cwd` **and `mcpServers`** — MCP servers are a
  *per-session input*, not an image concern. This is what makes "try a new MCP
  server" cheap.
- **Prompt turn**: `session/prompt` → a stream of `session/update` notifications
  (`plan`, `agent_message_chunk`, `tool_call`/`tool_call_update`, `usage_update`)
  → terminates with a `StopReason` (`end_turn`, `max_tokens`, `refusal`,
  `cancelled`, …).
- **Permissions ARE in ACP** (`session/request_permission`, client-side method).
  We do **not** drop them — we keep real permission prompts *and* add an
  idle/working-time signal as a complement.
- **`usage_update`** carries `used`/`size` tokens and optional `cost`
  (`{amount, currency}`) — free, agent-agnostic cost telemetry (but optional;
  see risks).
- **Lifecycle**: `session/new` | `session/load` (replays history, slow) |
  `session/resume` (no replay, fast — optional capability) | `session/close`.
- **Transport**: stdio JSON-RPC is the only stable transport. Remote HTTP/WS is a
  draft RFD. So remote pods need an **in-pod stdio↔network bridge**.

### Agent support matrix

| Harness | ACP support | Launch command | Notes |
|---|---|---|---|
| **opencode** | Native | `opencode acp` | Built-in; ship the binary, done. |
| **Claude Code** | Adapter | `claude-agent-acp` (`@agentclientprotocol/claude-agent-acp`) | Uses Anthropic API key (not Pro/Max). CLI-bridge adapters exist for subscription use. Pin a known-good version (MCP discovery broke in 0.16.x). |
| **pi** | Adapter | `pi-acp` (npx) or `harms-haus/pi-acp` | Community adapters over pi's `--mode rpc`/SDK. MVP-grade — expect to patch gaps. |

**Critical ecosystem gotcha**: several agents **silently ignore** `mcpServers`
injected via `session/new` (Cursor, Kiro, glm have shipped this bug). Mitigation
is designed in (§6.3): inject via ACP **and** write the agent's own MCP config
file, then verify tools are present after `session/new`.

---

## 4. Architecture overview

```
┌───────────────────────────── Manager (ACP CLIENT) ──────────────────────────┐
│  Orchestrator: task-spawner → AgentDispatch (ACP)                            │
│  • initialize / session.new / session.prompt                                 │
│  • receives session/update stream  → events → dashboard                      │
│  • handles session/request_permission → attention feed                       │
│  • AgentCatalog (harness + MCP + skill registry)                             │
│  • DevProfile resolver  (project ⊕ profile ⊕ session override)               │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │  WebSocket (JSON-RPC framed)   ── per session
                ▼
┌──────────────── Kata sandbox pod (unchanged substrate) ──────────────────────┐
│  Rust agent (:9998)                                                          │
│   ├── existing: exec / files / git / services / terminal / forwarder         │
│   └── NEW: ACP bridge   /acp/sessions  (WS ⇄ stdio)                          │
│            spawns  ⇒  [ opencode acp | claude-agent-acp | pi-acp ]            │
│                         (stdio JSON-RPC ACP agent subprocess)                 │
│                         cwd = workspace dir, mcpServers from profile          │
│  Tools (from profile): editor (code-server|none), browser, dev server        │
│  Profile materialized at boot: dotfiles, agent config, skills                │
└──────────────────────────────────────────────────────────────────────────────┘
```

Two new first-class concepts:

- **AgentDispatch** — the ACP client layer in the manager that replaces the
  OpenCode SDK calls. Agent-neutral; selects a harness per session.
- **DevProfile** — the portable per-developer config that parameterizes the pod.

---

## 5. The in-pod ACP bridge (Rust agent)

ACP agents speak stdio JSON-RPC; the manager is remote. We bridge stdio↔WebSocket
inside the pod. The recon confirms this mirrors the existing `terminal.rs` PTY
bridge almost exactly — no new crates needed (`tokio`, `tokio-tungstenite`,
`futures-util`, `serde_json` already present).

New module `apps/agent-rust/src/routes/acp.rs`:

- `POST /acp/sessions` — spawn the harness subprocess
  (`tokio::process::Command`, `stdin`/`stdout` piped; no PTY), return `{ sessionId }`.
- `GET /acp/sessions/:id` (WS upgrade) — bridge: child stdout → `broadcast` → WS;
  WS → `mpsc` → child stdin. Buffer early stdout so the client can replay.
- `DELETE /acp/sessions/:id` — SIGTERM the subprocess.
- Add four match arms to `apps/agent-rust/src/router.rs` (same shape as
  `/terminal/sessions*`).

The harness command itself is just another `ServiceConfig` entry (`command`,
`port`, `user`, `workdir`, `env`) supplied by the tool registry — **no
sandbox-config schema change required**. Framing note: ACP is newline-delimited
JSON-RPC over stdio; the bridge passes bytes through unmodified (transparent
relay), so protocol-version negotiation stays end-to-end between manager and
harness.

> Alternative considered: run a Node `ws-server.ts` from `@agentclientprotocol/sdk`
> as a per-pod sidecar process instead of extending the Rust agent. Rejected for
> the hot path — it adds a Node process to boot and a second supervision target.
> The Rust bridge is a transparent byte relay and reuses existing watchdog/exec
> infrastructure. (Bun can't run in Kata VMs anyway — that's why the agent is Rust.)

---

## 6. Dev Profiles

> **Superseded (§6–§8):** the "dev profile as a new layer + `(workspace ×
> profileHash)` composite snapshots" framing below is reworked in
> [`generic-sandbox-profiles.md`](./generic-sandbox-profiles.md) into a single
> generic `Profile` object (all sources are `Partial<Profile>` layers folded by a
> Profile Merger) with a substrate/runtime split that keeps the prebuild key at
> `workspace` instead of a per-profile matrix. Read that note for the current
> direction; the sections below are kept for context.

### 6.1 The object

A Dev Profile is the per-developer, portable analog of a Workspace. Source of
truth is a **file in the developer's dotfiles repo**, but it is **readable and
editable in the dashboard** (edits there are an unsaved/experimental overlay the
dev can later commit back — important: you don't want to commit an experiment to
your repo just to try it).

```toml
# devprofile.toml — canonical in dotfiles repo; mirrored/editable in dashboard
[agent]
harness = "pi"                       # pi | claude-code | opencode | <catalog id>
model   = "anthropic/claude-sonnet-4"

[[mcp]]                              # injected into every session/new
name = "linear"
type = "http"
url  = "https://mcp.linear.app/sse"
[[mcp]]
name    = "playwright"               # catalog id → pre-staged executable
catalog = "playwright"

skills   = ["frontend-review", "sql-explain"]   # catalog ids
editor   = "code-server"             # or "none" → pure SSH / BYO editor
dotfiles = "github.com/me/dotfiles"
```

New schema: `apps/manager/src/schemas/dev-profile.ts` —
`DevProfile { id, owner, agent, mcp[], skills[], dotfiles?, editor }` plus
`profileHash(profile)`. Workspace config gains `profiles?: DevProfile[]` /
`defaultProfileId?` (or profiles live at the user level and bind per spawn — see
[open question Q3](#9-open-questions)).

### 6.2 Resolution order

```
effective config = project workspace ⊕ dev profile ⊕ per-session override
```

This is the same deep-merge pattern already used by `ConfigFileService.getMergedForSandbox`.
Per-session override is the "Advanced" experiment panel (§7).

### 6.3 MCP servers: the reliability contract

Because injected `mcpServers` are unreliable across agents, every MCP server is
delivered **two ways** and then **verified**:

1. **ACP injection** — passed in `session/new.mcpServers`
   (stdio: absolute `command` path from the catalog on `/opt/shared`; http: URL).
2. **Agent config file** — written to the harness's own MCP config path via the
   existing config-file push (e.g. opencode's `opencode.json`, Claude's settings,
   pi's config). This is the fallback agents that ignore ACP injection will read.
3. **Verification** — after `session/new`, probe `available_commands_update` /
   the tool list; surface a "MCP not loaded" warning in the UI if missing.

stdio MCP servers must be on `PATH` as real executables — they come from the
catalog (pre-staged on the shared PVC), so no `npm install` on the hot path.

### 6.4 The catalog

Catalog-first, dashboard-managed (per the agreed decisions). A catalog entry is
a harness, MCP server, or skill that is **pre-staged on the shared binaries PVC**
(`/opt/shared`), so selecting it is a process spawn, not an install — instant,
and boot-budget-safe.

- **Adding to the catalog** = a two-click dashboard action that updates the
  shared-binaries Job (download/extract + symlink under `/opt/shared/bin`,
  extend the fingerprint string). Reuses the existing
  `charts/atelier/templates/shared-binaries-job.yaml` mechanism; the Job image
  needs `node`/`npm` for npm-distributed MCP servers (today it's `curl`-only).
- **Open-world is allowed but flagged "warming"**: an un-cataloged harness/MCP
  triggers a background fetch/prebuild and is available next boot; un-cataloged
  *MCP/skill* on an already-running session can often be hot-injected at the next
  `session/new` with no reboot. The UI clearly marks the warming state.

---

## 7. Dashboard UX

One schema, three editing surfaces:

1. **Profile-as-code** — the `devprofile.toml` in the dotfiles repo. Power users,
   portable across projects/machines, reviewable, versioned. Canonical.
2. **Dashboard profile editor** — a form over the same object: harness dropdown,
   MCP toggles from the **catalog**, skill chips, editor on/off, model picker.
   Discoverable and low-friction. Writes an overlay that the dev can "commit to
   dotfiles" when happy.
3. **Per-session "Advanced" overrides** — at task/session launch: swap harness,
   paste an MCP URL, attach a skill, *for this run only*. The rapid-experiment
   path. Never touches the repo.

### Experiment / harness comparison (the differentiator)

Tasks already carry `variantIndex`. Repurpose it: launch one task as **N harness
variants** against the *same* prebuilt project snapshot and compare on the
uniform ACP signals.

```
Task: "fix flaky auth test"
 ├─ A  pi + playwright-mcp      idle 4m12s · 38k tok · $0.21 · tests ✓
 ├─ B  claude-code (baseline)   idle 6m03s · 61k tok · $0.34 · tests ✓
 └─ C  opencode + new skill     idle 1m40s · ⚠ early-idle (perm?) · ✗
```

Metrics come for free: `usage_update` (tokens/cost), `StopReason` + idle-time +
permission events (the "worked only 10 s = something's wrong" warning the team
asked for), and post-hoc signals (tests pass, diff size). This turns "try new
stuff and see how it performs" into a measured A/B on real tasks — a harness
leaderboard, a genuinely novel surface.

### Attention feed, agent-agnostic

The existing attention block (`apps/dashboard/src/components/attention-block.tsx`)
maps cleanly onto ACP `session/request_permission` (the allow-once / allow-always /
reject options are already the ACP option shape). It's fed by:

- **Permission requests** (ACP, real) — primary.
- **Idle/working-time indicator** (derived from `session/update` cadence +
  `StopReason`) — complement; catches agents/cases where a stall isn't a formal
  permission prompt.

---

## 8. Fast boot: keeping < 10 s with everything ready

Hard rule: **nothing that needs a network install runs on the hot boot path.**
Everything is in a snapshot or pre-staged on the shared read-only PVC.

### Three layers

```
1. Project snapshot   (repo + deps)              ── shared, prebuilt (exists)
2. Profile layer      (harness/mcp/skills/        ── pre-staged on /opt/shared
                       dotfiles/editor)              + small per-user materialize
3. Experiment overlay (today's new thing)        ── session-level (ACP) or bg prebuild
```

### Composite prebuild snapshots, keyed by `(workspace × profileHash)`

The prebuild runner currently names snapshots `prebuild-{workspaceId}`. We extend
keying to include the profile:

- `snapshotNameForKey(workspaceId, profileHash?)` →
  `prebuild-{wsId}-{hash12}` (well under the 253-char K8s name limit).
- `PrebuildInfo` gains `profileHash`; the workspace holds **multiple** prebuilds
  (`Record<profileHash, PrebuildInfo>` or array) — one per active profile.
- Staleness (`prebuild-checker.ts`) also rebuilds when `storedProfileHash !==
  currentProfileHash`.
- Spawn resolves the dev's `profileHash`, picks the matching snapshot, or falls
  back to cold boot + a background prebuild for next time.

Result: a dev's **stable** profile is always pre-snapshotted → CoW-instant boot.
A **changed** profile is slow exactly once (background), instant thereafter.
An **experiment** that is only MCP/skill needs no reboot at all (ACP
session-level injection).

### Boot sequence (target ≤ 10 s)

```
t0   Kata CoW boot from composite snapshot                       ~2–4 s
     Rust agent binds :9998, /health green                        <0.1 s
t+   manager pushes profile manifest + auth/config files          ~0.3 s
     concurrently:
       • materialize dotfiles / agent config / skills             ~1 s
       • start editor (if profile.editor != none)
       • PRE-WARM ACP harness: spawn → initialize → session/new   ~2–4 s
         with the profile's MCP set; verify tools present
"ready" = handshake done + default session open + MCP connected
```

"Ready" is **not lazy**: the harness is initialized and the default session is
open with MCP servers connected, so the first prompt is instant. Only genuinely
on-demand tools (browser, extra dev servers) stay lazy.

Boot-budget guardrails (from recon): prebuild eliminates repo clone + dep install
+ warmup from the path; skeleton-copy is skipped when `.bun` exists (it does, in a
prebuilt PVC); the agent health gate is sub-100 ms after exec. The dominant new
cost is harness `initialize` — kept fast by pre-staged binaries and a pre-warmed
cache baked into the composite snapshot (the per-agent successor to
`opencode-warmup.ts`).

---

## 9. The orchestrator/ACP client layer

Replace the OpenCode SDK surface with an agent-neutral `AgentDispatch`. The
OpenCode→ACP mapping is direct (full table in
[Appendix A](#appendix-a--keep--refactor--delete-map)):

| Today (OpenCode SDK) | ACP |
|---|---|
| `createOpencodeClient({ baseUrl })` | ACP client over the pod WS bridge |
| `session.create({ title, directory })` | `session/new { cwd, mcpServers }` |
| `session.promptAsync({ … })` | `session/prompt` |
| `session.messages()` poll (delivery confirm) | `session/update` (role=user) |
| `event.subscribe()` SSE loop | ACP `session/update` stream over WS |
| `permission.list` / `permission.reply` | `session/request_permission` + response |
| `global.health()` / `app.agents()` | `initialize` + WS connect (no registry poll) |
| `StopReason`, `usage_update` | same names, native ACP |

Library: `@agentclientprotocol/sdk` (TypeScript) for the client side. The
reconnect/backoff scaffolding in `opencode-sse.ts` and the retry helpers in
`opencode-session.ts` are reused; only the call surface changes. `task-spawner.ts`
keeps its skeleton (spawn sandbox, branch, resolve template, build prompt) and
swaps `spawnSession` internals for `AgentDispatch`.

---

## 10. Impact summary

### Keep (the moat — untouched)
Kata/k3s orchestration · Rust agent core (exec/files/git/services/terminal/
forwarder/watchdog) · TopoLVM prebuilds & snapshots · sshpiper · dynamic ingress
+ wildcard TLS · CLIProxy + auth-sync polling infra · config-file storage/merge ·
shared-binaries PVC mechanism.

### Refactor (generalize for multi-agent)
Tool registry (drop `opencode` as sole `core`; harness becomes profile-driven) ·
`opencode-{client,session,sse,auth}.ts` → `AgentDispatch` (ACP) ·
`task-spawner.ts` internals · `opencode-warmup.ts` → per-agent warmup ·
`boot-waiter.ts` predicates · `sandbox-config.ts` `OpencodeWorkspaceContext` →
`AgentWorkspaceContext` · `internal.service.ts` `injectCliProxyProvider` →
per-agent config injection · `auth-sync.ts` per-agent credential merge ·
dashboard `opencode.ts` + attention/sessions/kanban (type substitution +
`opencodeUrl` → `agentUrl`).

### New
Rust `acp.rs` WS↔stdio bridge · `AgentDispatch` ACP client · `DevProfile` schema +
resolver · `AgentCatalog` (harness/MCP/skill registry + dashboard management) ·
composite `(workspace × profileHash)` prebuild keying · per-session experiment
overrides + variant comparison UI.

### Delete / retire
The hard dependency on `@opencode-ai/sdk/v2` as the *only* path. OpenCode itself
becomes one catalog harness (kept), so `packages/opencode-atelier` survives as the
opencode-specific adaptor, not the core.

---

## 11. Tradeoffs & risks

- **Adapter immaturity.** pi and Claude Code reach ACP through community/SDK
  adapters of varying maturity; opencode is native. *Mitigation*: opencode +
  Claude-Code-via-official-adapter as the launch set; pi behind a "beta" flag;
  pin known-good versions; a capability probe at `initialize` gates features.
- **`mcpServers` silently ignored** by some agents. *Mitigation*: dual delivery
  (ACP + config file) + post-`session/new` verification (§6.3).
- **`usage_update` is optional.** Cost/token metrics may be absent for some
  harnesses. *Mitigation*: treat as best-effort; fall back to CLIProxy-side
  accounting where available; never make billing depend on it.
- **Snapshot sprawl.** One prebuild per `(workspace × profile)` multiplies
  snapshots and storage. *Mitigation*: TopoLVM CoW makes deltas cheap; GC
  snapshots for profiles unused for N days; cap distinct profiles per workspace.
- **Boot regression risk.** Harness `initialize` + MCP connect is the new hot-path
  cost. *Mitigation*: pre-warm in the composite snapshot; measure per-harness;
  enforce the "no network install on boot" rule in review.
- **Remote transport is non-standard (today).** We bridge stdio↔WS ourselves
  because the HTTP/WS RFD isn't stable. *Mitigation*: transparent byte relay so we
  can swap to the standard transport when it lands without touching harnesses.
- **Permission UX in a headless orchestrator.** If the client never answers
  `session/request_permission`, the agent blocks forever. *Mitigation*: always
  register a handler; policy = surface to attention feed with an auto-timeout +
  `session/cancel` fallback.
- **Scope.** This touches manager, agent, dashboard, charts, and images at once.
  *Mitigation*: phased rollout (§12); each phase independently shippable.

---

## 12. Phased rollout

1. **ACP bridge + single-harness parity.** Add `acp.rs` WS↔stdio bridge; add
   `AgentDispatch`; run **opencode via `opencode acp`** through ACP instead of the
   SDK. Prove parity (sessions, prompts, stream, permissions) with zero UX change.
   Delete the SDK call sites behind a feature flag.
2. **Second harness.** Add Claude Code (`claude-agent-acp`) as a catalog harness.
   Generalize tool registry (`core` → profile-driven), `boot-waiter` predicates,
   per-agent warmup, config injection. Dashboard becomes agent-agnostic
   (`agentUrl`, ACP types).
3. **Dev Profiles + catalog.** `DevProfile` schema + resolver; dashboard profile
   editor + catalog management; dotfiles materialization at boot; dual MCP
   delivery + verification.
4. **Composite prebuilds.** `(workspace × profileHash)` snapshot keying;
   staleness; spawn-time selection. Hit the < 10 s budget per harness.
5. **Experiment surface.** Per-session overrides + N-variant harness comparison +
   the metrics leaderboard. Add pi (beta).

---

## Appendix A — Keep / refactor / delete map

Manager:

| File | Verdict | Note |
|---|---|---|
| `shared/lib/opencode-client.ts` | Refactor | → ACP client factory; keep timeout-fetch |
| `shared/lib/opencode-session.ts` | Refactor | maps 1:1 to ACP ops; keep retry/backoff |
| `shared/lib/opencode-sse.ts` | Refactor | keep reconnect loop; swap event source/types |
| `shared/lib/opencode-auth.ts` | Refactor | `buildOpenCodeAuthHeaders` agent-specific; `createTimeoutFetch` keep |
| `orchestrators/task-spawner.ts` | Refactor | skeleton keep; `spawnSession` → AgentDispatch |
| `orchestrators/opencode-warmup.ts` | Refactor | → per-agent warmup dispatcher |
| `orchestrators/kernel/boot-waiter.ts` | Refactor | extract `pollAgentHealth`; per-agent predicate |
| `orchestrators/kernel/sandbox-boot.ts` | Refactor | `opencodePassword`/`opencodeWorkspaceContext` → per-agent |
| `orchestrators/tools/registry.ts` | Refactor | registry pattern keep; harness profile-driven, not `core` |
| `orchestrators/sandbox-config.ts` | Refactor | `OpencodeWorkspaceContext` → `AgentWorkspaceContext` |
| `modules/internal/internal.service.ts` | Refactor | push infra keep; `injectCliProxyProvider` → per-agent |
| `modules/internal/auth-sync.service.ts` | Refactor | polling keep; `aggregateOpencodeAuth` → per-agent merge |
| `modules/config-file/config-file.service.ts` | Keep | agent-agnostic |

Agent (Rust):

| File | Verdict | Note |
|---|---|---|
| `apps/agent-rust/src/*` | Keep | agent-agnostic; only reads `config.json` commands |
| `apps/agent-rust/src/routes/acp.rs` | **New** | WS↔stdio ACP bridge (mirror `terminal.rs`) |
| `apps/agent-rust/src/router.rs` | Refactor | +4 `/acp/sessions*` arms |

Dashboard:

| File | Verdict | Note |
|---|---|---|
| `api/opencode.ts` | Refactor | → ACP HTTP/WS client |
| `api/queries/opencode.ts` | Refactor | re-point query/mutationFns |
| `hooks/use-opencode-data.ts` | Refactor | → `useAgentData` |
| `hooks/use-attention-data.ts` | Refactor | type substitution |
| `components/attention-block.tsx` | Refactor | ACP permission types; UI reusable |
| `components/sandbox-drawer/sessions-tab.tsx` | Refactor | `opencodeUrl` → `agentUrl` |
| `components/kanban/task-card.tsx` | Refactor | `tab1: "opencode"` → agent slug |

Infra:

| Item | Verdict | Note |
|---|---|---|
| shared-binaries PVC + Job | Keep / extend | add harnesses + MCP execs to catalog; Job needs node/npm; extend fingerprint |
| `prebuild-runner.ts` / `prebuild-checker.ts` | Refactor | profile-hash keying; multi-snapshot per workspace |
| `dev-base` image | Refactor | stop baking agent-specific assumptions; base + features |

---

## Appendix B — References

ACP spec:
- Introduction — https://agentclientprotocol.com/get-started/introduction
- Session setup (cwd + mcpServers) — https://agentclientprotocol.com/protocol/v1/session-setup
- Prompt turn (updates, StopReason) — https://agentclientprotocol.com/protocol/v1/prompt-turn
- Schema — https://agentclientprotocol.com/protocol/schema
- Transports (stdio + draft HTTP/WS) — https://agentclientprotocol.com/protocol/transports
- `usage_update` RFD — https://agentclientprotocol.com/rfds/session-usage
- MCP-over-ACP RFD — https://agentclientprotocol.com/rfds/mcp-over-acp

Libraries:
- TS SDK `@agentclientprotocol/sdk` — https://github.com/agentclientprotocol/typescript-sdk
- Rust SDK `agent-client-protocol` — https://github.com/agentclientprotocol/rust-sdk

Harness adapters:
- opencode native `opencode acp` — https://opencode.ai/docs/acp/
- Claude Code `@agentclientprotocol/claude-agent-acp` — https://github.com/agentclientprotocol/claude-agent-acp
- pi `pi-acp` — https://github.com/svkozak/pi-acp ; discussion https://github.com/earendil-works/pi/discussions/4444

Known issues (MCP injection ignored / version breaks):
- Cursor — https://forum.cursor.com/t/acp-agent-silently-ignores-mcpservers-in-session-new/153623
- Kiro — https://github.com/kirodotdev/Kiro/issues/7349
- glm — https://github.com/stefandevo/glm-acp-agent/issues/35
- claude-agent-acp 0.16.x MCP break — https://github.com/zed-industries/claude-agent-acp/issues/419
