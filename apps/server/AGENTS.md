# Atelier Server (v2)

The v2 deployable: `apps/server` ("the Atelier server", atelier-v2 §3.1).
One process, three internal modules with import boundaries enforced by
`scripts/check-boundaries.ts`, not convention. Developed on a **parallel
track** beside `apps/manager` (v1) — see `docs/proposals/atelier-v2.md` §6.
v1 keeps running untouched; nothing here is wired into v1's boot path.

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
bun run typecheck                                          # tsgo --noEmit
bunx drizzle-kit generate                                  # control/db schema migration
```

## Conventions

Same as `apps/manager` (see root `AGENTS.md`): manual DI in
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

## Known gaps (tracked, not silent)

- **M2 COMPLETE — runtime fully on the v2 agent.** `runtime/agent-config.ts`
  (`specToAgentConfig`) losslessly projects the spec onto the v2 agent
  (`apps/agent-v2`); boot pushes config via `PUT /config` (never
  ConfigMap-mounted) + `files/write`, then drives the phase order (postCreate
  -> reconcile -> primary `/health` gate -> postStart). Live-ops routes
  (process start/stop/logs/status, attach, addProcess) all target the v2
  agent's `/processes` + unified attach bridge (:9997). `scripts/deploy-k8s.sh`
  builds the agent from `apps/agent-v2` (self-building multi-stage image); the
  in-pod binary path stays `/usr/local/bin/sandbox-agent` (dev-base COPYs
  agent-v2's `/atelier-agent` there, so `sandbox-boot.sh` is unchanged).
  Deferred to M3/M6: `agent.operations.serviceList` + `sessions/acp` still use
  the v1 `service*`/`acp*` client methods (migrate then delete them).
- **Event bus / dashboard SSE / cron jobs** (auth-sync watcher, prebuild
  staleness, cliproxy refresh) are v1 features not yet ported — deferred to
  the milestone that needs them (§6 milestones 3–4), not silently dropped.
- **Org resolution in `/v1/sandboxes`** is a stub (`orgId = undefined`) —
  saved specs and secrets are org-scoped in the schema already; wiring the
  request → org lookup is pending real multi-org product decisions.
