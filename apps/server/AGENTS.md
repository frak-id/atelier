# Atelier Server

The server deployable: `apps/server` ("the Atelier server", design.md §3.1).
One process, three internal modules with import boundaries enforced by
`scripts/check-boundaries.ts`, not convention. See `docs/design.md` §3.

## Structure

```
src/
├── runtime/    MECHANISM. prebuild/boot/pause/resume/destroy · files/env/
│               processes/ports/hooks/exec/attach · kube builders · CSI
│               snapshots · agent client. Takes SandboxSpec, never Workspace.
│               MUST compile without control/ or sessions/ (the future
│               extraction seam). No FK to any identity table.
├── control/    POLICY. Identity (users/orgs/org-members), API keys, SSH
│               keys, saved specs (the Workspace replacement), the control
│               secrets store, org policy specs, and the two seam-crossing
│               enrichment steps (resolveSecrets + injectOrgPolicy). MUST
│               NOT import runtime/'s internals or sessions/.
├── sessions/   AGENT APP-TIER. ACP client + session facade (agent-dispatch,
│               acp-stream, session-surface) — parses ACP, so banned from
│               runtime/. A privileged CLIENT of runtime (attach + files,
│               same API anyone could use). MUST NOT import control/.
└── api/        HTTP shell: /v1/* → runtime (through control's authn +
                enrichment) · /api/* → control CRUD · /sessions/* →
                sessions · /mcp → same three. The only place all three
                modules are wired together (api/container.ts).
```

## The seam

`RuntimeService` (`runtime/runtime.service.ts`) is `runtime.create(spec)` as
a function signature policy code cannot reach past. `SandboxSpec`
(`@atelier/spec`) is the one document the runtime understands — no
`harness`, `mcp`, `skills`, or `dev` fields. Those are user-defined content:
files + processes + ports, composed client-side by `@atelier/compose`.

## Commands

```bash
ATELIER_SERVER_MODE=mock bun run --watch src/index.ts   # dev, no K8s needed
bun run scripts/check-boundaries.ts                       # enforce module boundaries
bun run typecheck                                          # tsc --noEmit (TypeScript 7)
bunx drizzle-kit generate                                  # control/db schema migration
```

## Conventions

See root `AGENTS.md`: manual DI in
`api/container.ts` / `control/container.ts`, `createChildLogger("name")`,
the `SandboxError` hierarchy, TypeBox schemas. The difference is *where*
things live, not the wiring style.

## Browser-consumable `App` type

Browser clients (`apps/console`) type their Eden Treaty client with
`import type { App } from "@atelier/server"`, so the console's TS program
(DOM lib) traverses this package's source. DOM's `WebSocket.send()` excludes
`SharedArrayBuffer`-backed views, so the WS byte-relays cast outgoing chunks
`as Uint8Array<ArrayBuffer>` (`api/v1.routes.ts`, `api/sessions.routes.ts`,
`sessions/acp/acp-stream.ts`). The values are always `ArrayBuffer`-backed at
runtime (Bun delivers binary frames as `Buffer`); the cast is a lib-compat
narrowing only. Any new Bun-specific WS/stream code that participates in the
`App` type may need the same narrowing.

The process-attach WS (`/v1/sandboxes/:id/attach/:name`) accepts an optional
`?mode=rw|ro` query (default `rw`): `ro` joins the runtime's read-only
fan-out and drops any client→upstream bytes. This is a pure passthrough —
`runtime.attach(id, name, mode)` already models both modes; the route just
exposes the existing capability so the GUI can offer a read-only attach.

## Sandbox access rule

`control/sandbox-access.ts` (`canAccessSandbox`, pure) is the one rule for
who may address a sandbox id: owner (`atelier.dev/owner-id`) or member of its
org (`atelier.dev/org-id`); bypassed-auth modes are open, a sandbox with
neither label is reachable by nobody. `api/sandbox-guard.ts` binds it: ONE `onBeforeHandle` guard per
router whose `:id` is a sandbox (`/v1` after the jobs sub-router,
`/sessions/sandboxes/:id/{agent,terminal}`), `requireSandboxAccess` in the WS
`open` handlers and every MCP tool taking a sandbox id, `accessibleSandboxes`
for list endpoints. Denied and unknown are the same `NotFoundError`. A new
`/v1` route with a sandbox `:id` is covered by registering it after the
guard; the guard only acts on paths under its prefix (`/v1/sandboxes/`,
`/sessions/sandboxes/`), and a missing user is a 401 except on a WS upgrade
(the socket's `open` check covers it). A sandbox id arriving in a body or
query (e.g. `POST /api/toolboxes/:id/versions/capture`) needs an explicit
`requireSandboxAccess`.
Not covered: `/v1/jobs` (feed unscoped), secrets routes, Launchpad (own
ownership).

## Integrations

`integrations/` is a registry of compiled-in links to external agent UIs
(`catalog.ts` lists them; `integration.ts` is the contract). The operator
enables each with `ATELIER_INTEGRATION_<ID>=true` (read once at boot by
`registry.ts`, never over the API); each person connects their own account
(`/api/integrations`, `control/modules/integration-connection/`). Vendor code
lives only in `integrations/<id>/`.

- **Boundary** (`check:boundary`): `integrations/` never imports `control/`,
  `sessions/` or `runtime/`; a vendor dir imports only `../integration.ts`,
  `shared/` and packages; only `catalog.ts` imports a vendor dir. Everything
  an integration touches arrives as arguments wired in `api/container.ts`.
- **Outbound:** `IntegrationHub` (`hub.ts`) is the `PermissionNotifier` of
  `AgentDispatch`. It routes a prompt to the sandbox OWNER's connections,
  filtered by risk and delay; the first answer wins and never throws.

See `docs/integrations/README.md`.

## Idle auto-pause

`docs/proposals/sandbox-idle-autopause.md`. One rule (the operator's
`sandbox.idle.*` config keys; no org or user override except a bounded
keep-awake annotation) over activity clocks, split along the boundaries:

- `runtime/activity.ts`: the in-memory recorder. `runtime.touch(id, signal)`
  (called for mutating runtime ops, create/resume, and by the callbacks
  below) and `runtime.pollActivity` (agent `GET /activity`, thresholds passed
  in). Not persisted: a restart floors every clock at the restart.
- `control/modules/idle-policy/`: reads the keys, validates keep-awake, and
  the pure `evaluateIdle`.
- `api/idle-reaper.ts`: the `Bun.cron` every minute (index.ts), the
  activity view, list decoration, keep-awake. It is the only place that
  sees ACP work (`AgentDispatch.workFor`) and jobs together with the rule.
- Signal hooks reach the runtime through callbacks wired in
  `api/container.ts` / `ssh/index.ts` (`AgentDispatch` `onActivity`, the SSH
  proxy's `onActivity`) or directly in api/ (`ws-relay.ts` `isUserInput`).

## Status notes & known gaps

- **Runtime runs on the in-pod agent (`apps/agent`).**
  `runtime/agent-config.ts` (`specToAgentConfig`) losslessly projects the
  spec onto the agent; boot pushes config via `PUT /config` (never
  ConfigMap-mounted) + `files/write`, then drives the phase order
  (postCreate -> reconcile -> primary `/health` gate -> postStart). Live-ops
  routes (process start/stop/logs/status, attach, addProcess) all target the
  agent's `/processes` + unified attach bridge (:9997). The agent image is
  built from `apps/agent` (self-building multi-stage image: the release
  workflow, or `infra/k8s/deploy.sh agent` in-cluster); the in-pod binary
  path stays `/usr/local/bin/sandbox-agent` (dev-base COPYs the agent's
  `/atelier-agent` there, so `sandbox-boot.sh` is unchanged).
- **No event bus.** The original POC's auth-sync watcher and cliproxy
  refresh were not carried over; add them when a feature needs them.
  Prebuild staleness is handled: `index.ts` schedules
  `refreshStalePrebuilds` + `pruneUnusedPrebuilds` as a
  `Bun.cron("*/30 * * * *")` job, gated on the `prebuild.gitTracking`
  config and skipped in mock mode.
- **Toolset tier (composed-prebuild-volumes.md) is COMPLETE end-to-end.**
  Built (`POST /v1/toolsets`) + captured (`POST /sandboxes/:id/toolsets/
  capture`) artifacts, agent materialize before files/env, `shared-binaries`
  killed (org toolbox is a built toolset), publish/delete lifecycle, full
  CLI + console surface. Deferred (proposal §6 items 8–10, independent
  control-plane work): repo-tier commit-keying/head-watching, the rung-1
  baked-pair cache, host-share/overlay perf spikes.
- **Pause/resume contract (fixed — was the `resume()` PVC collision).**
  `pause()` syncs, snapshots, persists `pauseSnapshotRef` on the record,
  then deletes pod/service/pipe (PVC kept). `resume()` reuses the live PVC
  when it still exists (no clone, no 409), else clones from the persisted
  pause snapshot, else falls back to the original `spec.source`; `error`
  records are resumable (the recovery route). Lifecycle ops (create/pause/
  resume/snapshot/destroy) serialize per sandbox id via an op lock and
  check status preconditions; `reconcileOnStartup()` sweeps zombie
  `creating`/pod-less `running` records to `error` at boot. Contract is
  pinned by `src/runtime/runtime.lifecycle.test.ts`.
