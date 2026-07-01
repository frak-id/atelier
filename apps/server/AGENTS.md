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

## Known gaps (tracked, not silent)

- **v1 agent, not v2.** `runtime/spec-to-config.ts` maps `processes[]` onto
  the existing v1 agent's `services` record so specs boot on today's images.
  The v2 agent line (mutable config, native `readiness`/`primary`, unified
  attach bridge with single-writer guard) is milestone 1 of the build plan —
  unbuilt. `RuntimeService.attach()`/`addProcess()` are honest
  approximations against the current agent's one-bridge model; see their
  doc comments.
- **Event bus / dashboard SSE / cron jobs** (auth-sync watcher, prebuild
  staleness, cliproxy refresh) are v1 features not yet ported — deferred to
  the milestone that needs them (§6 milestones 3–4), not silently dropped.
- **Org resolution in `/v1/sandboxes`** is a stub (`orgId = undefined`) —
  saved specs and secrets are org-scoped in the schema already; wiring the
  request → org lookup is pending real multi-org product decisions.
