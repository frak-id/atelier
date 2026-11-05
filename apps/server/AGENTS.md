# Atelier Server

The server deployable. One Bun process, several internal modules whose import
boundaries are enforced by `scripts/check-boundaries.ts`, not by convention.
Design background: `docs/archive/design.md` (historical) and
`docs/architecture.md`.

## Structure

```
src/
├── runtime/    MECHANISM. create/boot/pause/resume/destroy, prebuilds,
│               snapshots, toolsets, files/processes/ports/exec/attach, K8s
│               and Docker backends, agent client, image builders. Takes a
│               SandboxSpec, never identity. Compiles without control/,
│               sessions/, api/, ssh/ or harnesses/ (the extraction seam).
├── control/    POLICY. Users, orgs (owner|member), the default org and server
│               admins, API keys, SSH keys, secrets, toolboxes and versions,
│               server config plane, idle policy; spec enrichment and
│               resolveBootSpec. Uses runtime's barrel only.
├── sessions/   AGENT APP-TIER. ACP client (agent-dispatch, acp-stream) and
│               persisted agent tasks (task.service, task.store). Uses
│               runtime's barrel only; never imports control/.
├── harnesses/  Pure harness definitions (opencode, pi) and mergeSpecs. A leaf.
├── config/     Config schema (TypeBox), loader, constants. A leaf.
├── shared/     Errors, logger, db handle, runtime-config; may reach config/ only.
├── ssh/        The in-server SSH gateway (production mode only).
└── api/        HTTP + MCP shell and the only wiring point (container.ts).
    ├── app/    Application layer under HTTP and MCP: SandboxOps, ToolboxOps.
    │           No routes, no MCP tools, no elysia.
    └── mcp/    /mcp (13 sandbox tools) and /mcp/admin (4 admin tools).
```

Rules in one place: `scripts/check-boundaries.ts`. Run it with
`bun run check:boundary`.

## Where To Look

| Task | Location |
|------|----------|
| Sandbox create, fork, pause, resume, snapshot, destroy flow | `api/app/sandbox-ops.ts` (jobs, validation), `runtime/runtime.service.ts` (mechanism) |
| Prebuild keys, last-good fallback, retention | `runtime/prebuild.service.ts` |
| Toolset build and capture | `runtime/toolset.service.ts`, `runtime/build-pod.ts` |
| Toolbox authoring, pin, publish, transfer | `api/app/toolbox-ops.ts`, `control/modules/toolbox*` |
| Auto-resume on access | `api/forward-auth.ts`, `api/auth.routes.ts` (`/auth/wake`), `SandboxOps.ensureRunning` |
| Cron jobs | `api/scheduler.ts` |
| Idle auto-pause | `api/idle-reaper.ts`, `runtime/activity.ts`, `control/modules/idle-policy/` |
| Config keys and which are console-editable | `config/config.schema.ts`, `control/modules/server-config/registry.ts` |
| Agent HTTP/WS client, token, timeouts | `runtime/agent/` (`agent.contract.ts` holds the shared constants) |
| Agent tasks and results | `sessions/task.service.ts`, `sessions/task-result.ts`, `api/sessions.routes.ts` |
| Secrets resolution at boot | `control/enrichment.ts` (`resolveBootSpec`) |
| Default org, server admin rule | `control/default-org.ts` |
| Migrations | `drizzle/` (generate with `bun run db:generate`) |

## The seam

`RuntimeService` (`runtime/runtime.service.ts`) is a facade over
`PrebuildService`, `ToolsetService` and the lifecycle code, reachable as
`runtime.prebuilds` and `runtime.toolsets`. `SandboxSpec` (`@atelier/spec`) is
the one document the runtime understands: files, processes and ports. There
are no `harness`, `mcp` or `skills` fields. Harness content is composed in
`harnesses/` and applied in `control/enrichment.ts`.

Stored specs keep `{"$secret": "NAME"}` references. `resolveBootSpec` resolves
secrets and rebuilds git credentials at every boot (create, resume, fork), so
no secret value or token sits in a stored spec. The runtime receives the
resolver as `RuntimeDeps.resolveBootSpec`.

## Commands

```bash
bun run dev               # local mode, Docker backend, :4000 (needs Docker)
bun run check:boundary    # module boundaries
bun run typecheck         # tsc --noEmit
bun run db:generate       # drizzle-kit generate (control, runtime and sessions schemas)
bun run generate-schema   # regenerate schemas/*.json from config/config.schema.ts
```

Run them from `apps/server`, or from the root with `bun run --filter
@atelier/server <script>`.

## Modes

`ATELIER_SERVER_MODE` is `production` (default) or `local`. Local bypasses
auth (one fixed user, everyone is a server admin) and skips the SSH gateway.
The backend is chosen separately by `ATELIER_RUNTIME_BACKEND`
(`kubernetes` or `docker`). Production requires `SANDBOX_SECRETS_KEY`.

## Browser-consumable `App` type

The console types its Eden Treaty client with `import type { App } from
"@atelier/server"`, so its TS program (DOM lib) reads this package's source.
DOM's `WebSocket.send()` excludes `SharedArrayBuffer`-backed views, so the WS
byte relays cast outgoing chunks `as Uint8Array<ArrayBuffer>`
(`api/v1.routes.ts`, `api/sessions.routes.ts`, `sessions/acp/acp-stream.ts`).
The values are always `ArrayBuffer`-backed at runtime. New Bun-specific WS or
stream code that participates in the `App` type may need the same cast.

## Sandbox access rule

`control/sandbox-access.ts` (`canAccessSandbox`) is the one rule for who may
address a sandbox id: the owner (`atelier.dev/owner-id`) or a member of its
org (`atelier.dev/org-id`). Auth-bypassed mode is open, and a sandbox with
neither label is reachable by nobody. `api/sandbox-guard.ts` binds it: one
`onBeforeHandle` guard per router whose `:id` is a sandbox, `requireSandboxAccess`
in WS `open` handlers and in every MCP tool taking a sandbox id, and
`accessibleSandboxes` for list endpoints. Denied and unknown both answer
`NotFoundError`. A new `/v1` route with a sandbox `:id` is covered by
registering it after the guard. A sandbox id arriving in a body or query needs
an explicit `requireSandboxAccess`. Tool URLs apply the same rule
(`/auth/forward` answers 403). The jobs feed is scoped in `api/job-access.ts`:
a caller sees a job they own (`metadata.owner`), one on a sandbox they can
access, or every job as a server admin; cancel is owner or admin.

## Server admins

A server admin is an owner of the org named by `auth.defaultOrg`
(`control/default-org.ts`). Admin-only: `PUT /api/config`, image build,
register and delete, toolset publish and remove, prebuild delete, and the
whole `/mcp/admin` endpoint. A prebuild's dev servers (`surface`) can be
changed by its creator or an admin, and `GET /v1/prebuilds` masks `env` values
and file contents for everyone else. The default org's slug is reserved: it
cannot be renamed, deleted or created through the API (only
`joinDefaultOrg` creates it on a fresh install). In local mode, or when
`auth.defaultOrg` is unset (only allowed outside production), everyone is an
admin.

## Related docs

- Idle auto-pause and auto-resume: `docs/idle-autopause.md`
- Toolbox versions, refresh and transfer: `docs/toolbox-versions.md`
- Config keys: `docs/advanced-configuration.md`
- Conventions and DI: `docs/patterns.md`
