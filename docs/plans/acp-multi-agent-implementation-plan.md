# ACP Multi-Agent — Implementation Plan

Status: **plan — derived from `docs/proposals/acp-multi-agent-dev-profiles.md`, grounded in code recon**

Scope of this plan: the two goals requested —
1. Remove the hardcoded OpenCode SDK dependency and introduce an ACP layer everywhere it's needed (dashboard, manager, agent).
2. Generify the harness so OpenCode is one of several (Claude Code, Codex, pi, …), even while OpenCode is the only one wired up today.

Dev Profiles, catalog, composite prebuilds and the experiment/leaderboard surface
(proposal §6–§8, §12 phases 3–5) are **out of scope here** — this plan delivers
the agent-neutral substrate they build on. The proposal remains the north star.

---

## 0. Key architectural decision (made)

**The manager becomes the single ACP client and exposes a normalized facade
(REST + SSE/WS) to the dashboard.** The dashboard stops talking to pods directly.

Why this matters and what the recon showed:

- Today the dashboard calls each pod's OpenCode HTTP/SSE server **directly** via
  `sandbox.runtime.urls.opencode` (`apps/dashboard/src/api/opencode.ts`,
  `lib/opencode-events.ts`). That server **disappears** under ACP — an ACP agent
  is a stdio JSON-RPC subprocess behind the Rust WS bridge, not a REST server.
- ACP defines `session/request_permission` as a **client-side** method. If both
  the manager and the dashboard were ACP clients, they'd race to answer it.
- Therefore: manager owns the ACP client connection + session/event/permission
  state; dashboard reads a stable manager API. This keeps the dashboard's current
  query/SSE shape almost intact — only the base URL and types change.

Consequence: the manager gains a per-session **AgentSession state store** and an
**event fan-out** (it already has the SSE reconnect scaffolding in
`opencode-sse.ts` to build on).

---

## 1. Target architecture

```
Dashboard ── REST + SSE/WS ──▶ Manager (ACP CLIENT + facade)
                                  │  AgentDispatch: initialize / session.new /
                                  │    session.prompt; consumes session/update;
                                  │    answers session/request_permission
                                  │  AgentSessionStore + event fan-out (facade)
                                  ▼  WS (JSON-RPC framed), per session
                          Rust agent (:9998)  ── NEW /acp/sessions* (WS⇄stdio)
                                  ▼  spawns
                          [ opencode acp | claude-agent-acp | pi-acp ]  (stdio)
                                  cwd = workspace, mcpServers from profile
```

Two new manager concepts (proposal §4): **AgentDispatch** (ACP client surface)
and an **AgentSessionStore/facade** (normalizes ACP for the dashboard). The
harness command becomes a profile-/registry-driven `ServiceConfig` entry, not a
hardcoded `opencode serve`.

---

## 2. Naming / contract conventions (apply throughout)

To "generify even with only opencode," establish neutral names now and make
opencode an implementation of them:

- `opencode*` → `agent*` for cross-cutting fields:
  `sandbox.runtime.urls.opencode` → `urls.agent`;
  `opencodePassword` → `agentPassword`; `opencodeUrl` prop → `agentUrl`;
  boot stage `waiting-for-opencode` → `waiting-for-agent`.
- New shared types live in `@frak/atelier-shared` (agent-neutral), mirroring the
  OpenCode SDK shapes the dashboard already consumes (`AgentSession`,
  `AgentSessionStatus`, `AgentTodo`, `AgentPermissionRequest`,
  `AgentQuestionRequest`, `AgentEvent`). The recon captured exact consumed fields
  (Appendix in dashboard scout) — these become the contract.
- A `HarnessAdapter` interface in the manager encapsulates everything
  opencode-specific (launch command, config-file path/shape, auth-file format,
  capability probe). OpenCode is the first implementation; Claude Code/pi slot in
  later without touching call sites.

---

## 3. Phased rollout

Each phase is independently shippable. Phases 1–4 deliver both goals; phases 5–6
map to proposal phases 2 (second harness) and are where multi-agent goes live.

### Phase 1 — Rust ACP bridge (`acp.rs`)

Mirror `apps/agent-rust/src/routes/terminal.rs`, but stdio not PTY (recon
confirmed the pattern maps cleanly; no new crates — `tokio` process/io-util,
`tokio-tungstenite`, `futures-util`, `serde_json` all present).

- New `apps/agent-rust/src/routes/acp.rs`:
  - `POST /acp/sessions` — spawn harness via `tokio::process::Command`
    (`stdin`/`stdout`/`stderr` piped, `process_group(0)`, uid/gid + env + cwd from
    the `ServiceConfig`, same as `process_manager.rs:95`). Return `{ sessionId }`.
  - WS bridge (separate TCP listener, peek-for-session-id, same as terminal):
    child stdout → `OutputBuffer` (replay) + `broadcast` → WS;
    WS → `mpsc` → child stdin. **Transparent byte relay** (newline-delimited
    JSON-RPC passes through unmodified, so version negotiation stays end-to-end).
  - `DELETE /acp/sessions/:id` — SIGTERM the child; `child.wait()` task auto-reaps
    and deletes the session on exit.
  - stderr: frame into a side channel for logs (don't pollute the JSON-RPC stream).
- `apps/agent-rust/src/router.rs`: add `(POST|GET, "/acp/sessions")` match arms +
  a `strip_prefix("/acp/sessions/")` block in the catch-all (4 arms, mirrors
  `/terminal/sessions/`).
- `main.rs`: `ensure_acp_from_config()` (mirror `ensure_terminal_from_config`),
  reading `config.services["acp"]`. No `config.json` schema change — it's just a
  service entry.

Exit criteria: can spawn `opencode acp` in a pod, exchange raw JSON-RPC over WS,
clean lifecycle. Pure additive; nothing else changes.

### Phase 2 — Manager AgentDispatch (ACP client) + facade

Replace the `@opencode-ai/sdk` runtime surface with an ACP client; keep the
retry/backoff/reconnect scaffolding.

- Add `@agentclientprotocol/sdk` (TS) for the client side.
- New `apps/manager/src/shared/agent/` module:
  - `agent-client.ts` — ACP client over the pod WS bridge (replaces
    `opencode-client.ts`'s `createOpencodeClient`). Keep `createTimeoutFetch`.
  - `agent-session.ts` — `session/new`, `session/prompt`, consume `session/update`
    stream, `session/request_permission` handler. Maps 1:1 from
    `opencode-session.ts` (recon table §9 of proposal); preserve the
    send-and-verify retry semantics (ACP delivery confirmation via
    `session/update` role=user).
  - `agent-events.ts` — event stream consumption; reuse the reconnect loop shape
    from `opencode-sse.ts` (`OPENCODE_SSE_DEFAULTS`).
  - `agent-health.ts` — `initialize` + WS connect predicate replacing
    `boot-waiter.ts`'s `client.global.health()`/`client.app.agents()`.
- New `AgentSessionStore` + **facade API** in the manager that the dashboard will
  consume (Phase 4). Normalizes ACP `session/update` into the existing shapes:
  sessions, statuses, todos, permissions, questions, + an SSE/WS event feed
  re-emitting `session.*`/`permission.*`/`question.*`/`todo.updated`.
- `HarnessAdapter` interface + `OpencodeAdapter` implementation holding: launch
  command, MCP/config-file path (`~/.config/opencode/opencode.json`), auth-file
  format/merge (the `expires`-based logic from `auth-sync.service.ts`), Basic-auth
  username `opencode`, capability probe.
- Rewire `task-spawner.ts`: keep skeleton (spawn sandbox, branch, resolve
  template, build prompt); swap `spawnSession` internals to AgentDispatch.
  `updateSessionTitles` → ACP session update.

Exit criteria: OpenCode runs **through ACP** (via `opencode acp`) instead of the
SDK, behind a feature flag. Parity on sessions/prompts/stream/permissions. SDK
still present but no longer on the hot path.

### Phase 3 — Generify tool registry, boot, warmup, auth, config injection

Remove opencode-as-mandatory-core; make the harness profile/registry-driven.

- `orchestrators/tools/registry.ts`: drop `core: true` hardcoding; the harness
  becomes a registry entry whose command comes from the selected `HarnessAdapter`.
  Generalize `bootServiceNames()`/`coreServiceNames()` and `ToolContext`
  (`opencodePassword`/`opencodeEnv` → `agentPassword`/`agentEnv`).
  `ports/guest-base.ts` `CRITICAL_SERVICES` → the active harness slug.
- `opencode-warmup.ts` → `agent-warmup.ts`: per-adapter warmup dispatcher
  (opencode keeps its `session.list`/`app.agents`/`find.text` bootstrap behind the
  adapter; cache path, ports, kill-pattern move into `OpencodeAdapter`).
- `kernel/boot-waiter.ts`: extract `pollAgentHealth`; per-adapter predicate.
- `kernel/sandbox-boot.ts` + `sandbox-config.ts`: `OpencodeWorkspaceContext` →
  `AgentWorkspaceContext`; `opencodePassword` → `agentPassword`.
- `internal.service.ts` `injectCliProxyProvider` → adapter-provided config path +
  merge shape. `auth-sync.service.ts` `aggregateOpencodeAuth` → adapter-provided
  auth merge (keep the generic poll/push infra).
- Schemas: `schemas/sandbox.ts` (`urls.agent`, `agentPassword`, boot stage,
  `agentWorkspaceContext`), `schemas/session-template.ts` (drop
  `AppAgentsResponse`/`ProviderListResponse` SDK type imports → neutral types),
  `schemas/public-config.ts`. DB column `opencode_workspace_context` →
  `agent_workspace_context` (migration). K8s `kube.resources.ts` env var +
  port name. `api/auth.routes.ts` forward-auth route subdomain/header via adapter.

Exit criteria: nothing in manager core references `opencode` except inside
`OpencodeAdapter`. Adding a harness = adding an adapter.

### Phase 4 — Dashboard onto the manager facade

Re-point the dashboard from per-pod OpenCode to the manager facade; swap SDK
types for `@frak/atelier-shared` agent types.

- `api/opencode.ts` → `api/agent.ts`: replace `createOpencodeClient` + all
  `client.*` calls with fetch calls to the manager facade (endpoint table in
  proposal §10 / dashboard scout §10A). Drop `@opencode-ai/sdk/v2/client` import;
  Basic-auth registration moves behind the facade (manager holds pod creds).
- `lib/opencode-events.ts` → facade SSE/WS (`EventSource`/fetch SSE); same
  event-type → cache-invalidation mapping.
- Type swap across the ~17 files the scout enumerated
  (`PermissionRequest`/`QuestionRequest`/`Session`/`Todo`/`Event` →
  `Agent*`). `opencodeUrl` props → `agentUrl`; `sandbox.runtime.urls.opencode` →
  `urls.agent`. `tab1: "opencode"` slug → `agent` (optional cosmetic).
- `attention-block.tsx` / `expandable-interventions.tsx`: unchanged UI; types only
  (already shaped like ACP allow-once/allow-always/reject).
- Remove `@opencode-ai/sdk` from `apps/dashboard/package.json`.

Exit criteria: dashboard builds with no `@opencode-ai/sdk` import; kanban /
attention / sessions work against the facade, agent-agnostic.

### Phase 5 — Retire the hard SDK dependency

- Remove the feature flag from Phase 2; ACP path is the only path.
- `@opencode-ai/sdk` survives only inside `OpencodeAdapter` /
  `packages/opencode-atelier` as the opencode-specific adaptor (proposal §10
  "Delete/retire": it becomes one catalog harness, not the core).

Exit criteria: `@opencode-ai/sdk` removed from manager core; opencode is just an
adapter.

### Phase 6 — Prove genericity with a second harness (validation)

Add `claude-agent-acp` as a second `HarnessAdapter` (pinned known-good version per
proposal §3 gotchas) — even if not exposed to users yet. This is the litmus test
that the abstraction holds. Defer Dev Profiles/catalog/composite prebuilds to the
proposal's later phases.

Exit criteria: a sandbox can boot OpenCode **or** Claude Code by changing only the
adapter selection — no call-site changes.

---

## 4. File-level work map (condensed, from recon)

### agent-rust (additive)
| File | Action |
|---|---|
| `src/routes/acp.rs` | **New** — WS↔stdio bridge (mirror `terminal.rs`) |
| `src/router.rs` | +4 `/acp/sessions*` arms |
| `src/main.rs` | `ensure_acp_from_config()` |

### manager (refactor → agent-neutral)
| File | Action |
|---|---|
| `shared/lib/opencode-client.ts` | → `shared/agent/agent-client.ts` (ACP) |
| `shared/lib/opencode-session.ts` | → `agent-session.ts` (1:1 ACP map; keep retries) |
| `shared/lib/opencode-sse.ts` | → `agent-events.ts` (keep reconnect loop) |
| `shared/lib/opencode-auth.ts` | → adapter (Basic-auth username parameterized) |
| `orchestrators/task-spawner.ts` | swap `spawnSession` internals → AgentDispatch |
| `orchestrators/opencode-warmup.ts` | → `agent-warmup.ts` (per-adapter) |
| `orchestrators/kernel/boot-waiter.ts` | extract `pollAgentHealth`; per-adapter |
| `orchestrators/kernel/sandbox-boot.ts` | `opencodePassword`/context → `agent*` |
| `orchestrators/tools/registry.ts` | drop `core`; harness = adapter-driven |
| `orchestrators/sandbox-config.ts` | `OpencodeWorkspaceContext` → `AgentWorkspaceContext` |
| `ports/guest-base.ts` | `CRITICAL_SERVICES` → active harness slug |
| `modules/internal/internal.service.ts` | `injectCliProxyProvider` → adapter config path |
| `modules/internal/auth-sync.service.ts` | `aggregateOpencodeAuth` → adapter merge |
| `schemas/{sandbox,session-template,public-config}.ts` | neutral fields/types |
| `infrastructure/database/schema.ts` | rename `opencode_workspace_context` (+migration) |
| `infrastructure/kubernetes/kube.resources.ts` | env var + port name |
| `api/auth.routes.ts` | forward-auth route via adapter |
| `api/sandboxes/index.ts`, `api/session-template.routes.ts` | facade calls |
| **New** facade module | AgentSessionStore + REST/SSE the dashboard consumes |

### dashboard (refactor)
| File | Action |
|---|---|
| `api/opencode.ts` | → `api/agent.ts` against manager facade |
| `api/queries/opencode.ts`, `keys.ts` | re-point fns/keys |
| `lib/opencode-events.ts` | facade SSE |
| `hooks/use-*` (opencode/attention/all-sessions/task-progress/session-interaction) | type swap |
| `lib/{opencode-helpers,session-hierarchy,intervention-helpers}.ts` | type swap |
| `components/{attention-block,expandable-interventions,session-hierarchy,session-todo-info,todo-progress-bar}.tsx` | type swap |
| `sandbox-drawer/sessions-tab.tsx` | `Session`/`Todo` → `Agent*`; `agentUrl` |
| `kanban/task-card.tsx` et al | `urls.agent`; optional `tab1` slug rename |
| `providers/opencode-events-provider.tsx` | facade auth bootstrap |
| `package.json` | remove `@opencode-ai/sdk` |

### shared
| Item | Action |
|---|---|
| `@frak/atelier-shared` | **New** agent-neutral types (`AgentSession`, `AgentTodo`, `AgentPermissionRequest`, `AgentQuestionRequest`, `AgentSessionStatus`, `AgentEvent`) |

---

## 4b. Empirical findings — `opencode acp` 1.17.10 (validated locally)

Drove real `opencode acp` over stdio with the manager's installed
`@agentclientprotocol/sdk` (`ClientSideConnection` + `ndJsonStream`). Confirmed:
launch command `opencode acp`; **ndjson framing** (single `\n`-terminated
JSON-RPC objects, no Content-Length headers) — the transparent byte relay is
sound; `protocolVersion: 1`; method names `initialize` / `session/new` /
`session/prompt` / `session/cancel` / `session/update` / `session/request_permission`
all match the dispatch's calls.

Three findings that changed / must inform the code:

- **Model selection: `_meta` is ignored — use `session/set_config_option`.**
  `_meta.model/variant/agent` on `session/prompt` is silently dropped; the
  session keeps its default model. Real mechanism: `session/set_config_option`
  with `{sessionId, configId:"model"|"mode", value:"<provider>/<model>"}` (flat
  string ids from the `configOptions` array returned by `session/new`). **Fixed**
  in `harness-adapter.ts` (`sessionConfig()`) + `agent-dispatch.ts`
  (`setSessionConfigOption` before prompt). Verified end-to-end with a real
  completion. `variant` had no ACP mapping and was dropped.
- **Auth fails silently deep in the turn.** Missing/invalid provider auth does
  **not** fail `initialize`/`session/new`; it fails inside `session/prompt`'s
  stream loop with no ACP-visible error and no `session/update` — the turn just
  resolves `end_turn` with 0 tokens. Phase 3 auth-sync validation must probe an
  actual completion, not just session creation.
- **Relay forwards non-JSON stdout verbatim.** A user opencode *plugin* wrote a
  plain-text banner to stdout; `ndJsonStream` logged-and-skipped it (non-fatal).
  Unlikely in a clean pod image, but `acp.rs` has no defense against a harness
  (or its plugins) writing non-JSON-RPC bytes to stdout. Validate against the
  pod's actual opencode/plugin set; add a defensive log filter only if it recurs.
- **Not yet exercised:** `session/request_permission` (needs a tool-call prompt)
  and `session/cancel` end-to-end. Re-validate when wiring permission handling.

---

## 5. Risks specific to this plan

- **Facade is new surface area.** The manager must hold per-session ACP state and
  re-emit events the dashboard already expects. Mitigate by mirroring the exact
  shapes the dashboard consumes (recon captured them) — it's a translation layer,
  not a redesign.
- **ACP delivery semantics differ from OpenCode's `promptAsync` 204-drop.**
  Re-validate the send-and-verify retry against `session/update` role=user before
  deleting the old verify logic.
- **`mcpServers` reliability / capability gaps** — out of scope here but the
  `HarnessAdapter` must expose a capability probe so later phases can do dual
  delivery + verification (proposal §6.3).
- **Field renames touch DB + K8s + schemas at once.** Sequence: add neutral fields
  alongside old, migrate, then remove — keep each phase shippable.
- **Bridge framing.** Must be a transparent byte relay; do not parse/transform
  JSON-RPC in `acp.rs` or version negotiation breaks.

---

## 6. Suggested first PR

Phase 1 (`acp.rs` bridge) — fully additive, no behavior change, validates the
hardest new primitive against a real `opencode acp` process. Everything else
builds on a working bridge.
