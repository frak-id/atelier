# atelier-v2 — build status & handoff

Implementation status of `docs/proposals/atelier-v2.md` on branch `feat/v2`.
**Milestones 1–5 are server-complete.** The GUI rewrite (M5 c/d) is
product-owned and deferred; v1 decommission (M6) is gated on zero live v1
sandboxes. See `v1-decommission.md` for the M6 checklist, `apps/server/AGENTS.md`
for architecture, and `apps/server/PHASE0.md` for remaining deferrals.

## What ships

| Milestone | Status | Where |
|---|---|---|
| 1. v2 Rust agent | ✅ done | `apps/agent-v2` (`atelier-agent`) |
| 2. v2 runtime on v2 agent | ✅ done | `apps/server/src/runtime` |
| 3. control + sessions + compose + CLI | ✅ done | `apps/server/src/{control,sessions}`, `apps/cli`, `packages/compose` |
| 4. prebuild + catalog | ✅ done | `runtime.service.ts` (`prebuild`/`catalogAdd`) |
| 5. GUI v2 | ⏸ server-complete; **GUI product-owned/deferred** | API ready across all surfaces |
| 6. decommission v1 | ⏸ gated on zero v1 sandboxes | `v1-decommission.md` |

### Agent (`apps/agent-v2`)
Standalone Rust crate, static musl → `scratch` image, shipped in `dev-base` as
`/usr/local/bin/sandbox-agent`. Mutable watched config (`PUT /config` +
`POST /reconcile`), supervisor (autostart, readiness port|http|cmd, `primary`
health gate, `after`/`restart`/`lazy`/`stdio`), unified attach bridge on `:9997`
(single-writer guard + ro fan-out, stdio + PTY), phased hooks
(`POST /hooks/{phase}`), `exec`/`exec/batch`, `files/write`, generic N-port
forwarder, `GET /processes/*/logs`. HTTP control on `:9998`.

### Runtime (`apps/server/src/runtime`) — MECHANISM
`RuntimeService` is the seam: create/get/list/pause/resume/destroy, files/env,
processes/ports/hooks, exec, attach, snapshot, `prebuild` (real: temp pod →
`build[]`/`repos` → VolumeSnapshot, content-hash keyed + chained), `catalogAdd`
(checksum-verified install onto the shared `/opt/shared` PVC via a one-shot
Job). Boot pushes config (`PUT /config` + `files/write`, no ConfigMap — secrets
never hit etcd) and gates on the spec's `primary` process. Persists to sqlite
(`sandboxes`/`snapshots`/`catalog`). Never imports `control/` or `sessions/`;
never parses ACP.

### Control (`apps/server/src/control`) — POLICY
Users, orgs+members, GitHub OAuth, API keys, SSH keys, secrets, saved specs,
org policy. Enrichment at the seam (`enrichSpec`: `resolveSecrets` +
`injectOrgPolicy`) — `{"$secret":"NAME"}` refs resolved here, never stored in
specs at rest.

### Sessions (`apps/server/src/sessions`) — AGENT APP-TIER
`AgentDispatch` is the single ACP hub: one shared rw attach per sandbox
(`:9997`), session registry + pending-permission buffer + per-sandbox event
emitter. `AcpSessionSurface` is the stateless live facade the dashboard/SSE
consume. Reaches sandboxes only through the runtime attach API.

### Three surfaces, one API
- **CLI** (`apps/cli`, `atelier`): up (+`--bake`), ps, get, logs, exec, pause,
  resume, rm, attach, sync, expose, snapshot, prebuild, catalog. Thin `/v1`
  client, no server imports.
- **MCP** (`/mcp`): 11 tools (create/get/list/exec/logs/pause/resume/rm/
  patch_files/expose_port/snapshot).
- **GUI**: the read API + SSE it needs already exist; the React app is the
  deferred work.

## Running it
```bash
# Mock mode (no k8s): boots on :4000, accepts any non-atl_ bearer as mock-user
cd apps/server && ATELIER_SERVER_MODE=mock bun run src/index.ts

# CLI against it
ATELIER_API_URL=http://localhost:4000 ATELIER_API_KEY=mock bun apps/cli/src/index.ts ps

# Deploy (real k8s): builds agent image from apps/agent-v2
scripts/deploy-k8s.sh
```

## Validation gates (all green at handoff)
`bun run typecheck` (server/cli/spec), `bun run scripts/check-boundaries.ts`,
`bunx biome check <changed>`, mock-mode e2e smokes, cross-language agent smokes,
local-WS ACP-stub smokes; Rust `cargo clippy --all-targets -- -D warnings` +
`cargo test`. Pre-existing whole-repo biome errors live only in v1
`apps/dashboard`/`apps/manager`/`infra` (cleared by M6).

## Deferred (not blockers)
- **GUI (M5 c/d):** product-owned rewrite of `apps/dashboard` against `/v1`.
- **M6 decommission:** gated on zero v1 sandboxes — see `v1-decommission.md`.
- **Quotas module, multi-org header, MCP per-user identity:** `PHASE0.md`.
- **Prebuild snapshot-timeout reconciler:** untracked-but-labeled VolumeSnapshot
  on timeout; GC-findable, no reconciler yet.
