# v1 Decommission Checklist (atelier-v2 milestone 6)

Milestone 6 deletes the v1 line. **Gate: do NOT delete anything here until the
v1 sandbox count is zero** (any live v1 sandbox still depends on the v1 agent
and v1 manager). This is an operational cutover, not a code refactor — the v2
server, agent, CLI, and MCP surfaces (milestones 1–5) are complete and already
carry all new sandboxes.

Status legend: `[ ]` pending · `[~]` partially done in v2 dev · `[x]` done.

## 0. Preconditions (verify before deleting)
- [ ] `atelier ps` (or the operator fleet view) shows **zero** sandboxes booted
      on the v1 agent line.
- [ ] All saved specs / presets in use compose an `acp` primary process
      (v2 harness), not a v1 `opencode serve` service.
- [ ] Prod is serving the v2 `apps/server` on `/v1` + `/sessions` + `/mcp`, and
      the v2 dashboard (once it exists) has replaced the v1 one.

## 1. Deployables to delete
- [ ] **`apps/manager`** — the entire v1 server (workflows, registry,
      boot-waiter, v1 routes/Eden). Frozen; superseded by `apps/server`.
- [ ] **`apps/dashboard`** — the v1 React app (Vite + TanStack + Radix + xterm),
      coupled to `@frak/atelier-manager` via Eden. Delete once the v2 GUI
      (milestone 5 c/d, product-owned) replaces it. Until then it is the only
      consumer of `apps/manager`.
- [ ] **`apps/agent-rust`** — the v1 in-pod Rust agent. Frozen; superseded by
      `apps/agent-v2` (`atelier-agent`, shipped in `dev-base` as
      `/usr/local/bin/sandbox-agent`). Committed source only; `dist/` is
      gitignored.

## 2. Build / deploy references to update on deletion
- [ ] `scripts/bump-version.ts` — `CARGO_TOML_PATH = "apps/agent-rust/Cargo.toml"`
      still bumps the v1 agent. Point at `apps/agent-v2` or drop.
- [ ] `scripts/deploy-k8s.sh` — comment references the frozen v1 agent line
      (deploy already builds `AGENT_IMAGE` from `apps/agent-v2`, M2/2c-ii). Drop
      the v1 note; confirm no v1 manager/dashboard build/deploy steps remain.
- [ ] Root workspace `package.json` / Bun workspaces — drop `apps/manager`,
      `apps/dashboard` (v1), `apps/agent-rust` from members once deleted.

## 3. In-image / infra legacy
- [ ] **`infra/images/dev-base/rootfs/etc/sandbox/sandbox-init.sh`** — the v1
      heartbeat/log-rotate wrapper loop (`/run/sandbox-agent.heartbeat`, stale
      detection + kill). The current pod entrypoint is `sandbox-boot.sh`;
      `sandbox-init.sh` is unreferenced by the Dockerfile. Delete after
      confirming nothing (dev-cloud/dev-rust derived images, any legacy pod
      spec) still invokes it.
- [ ] **Helm `sharedBinaries.*`** — tool-version pins replaced by the
      checksum-verified catalog (M4/c, `atelier catalog add … --sha256`).
      Remove the chart values + any populate-job once the catalog volume is the
      source of truth in prod.

## 4. Compatibility shims to confirm-absent
- [ ] doc §6 "compatibility alias table" — no such table exists in the v2
      server (`apps/server`) or `@atelier/spec`. If one lives in `apps/manager`
      (image/tool alias map), it dies with §1. Verify none leaked into v2.

## Already removed during v2 dev (context; no action)
- `apps/server/src/runtime/spec-to-config.ts` (v1 projection) — deleted M2/2b-ii.
- v1 agent client methods: `acpSessionCreate/Delete/acpWebSocketUrl` (M3/b),
  `service*`/`git*` + `AgentOperations` (cleanup 1), the whole
  `sessions/harnesses/opencode/` `opencode serve` HTTP surface (cleanup 2).
- The config ConfigMap that leaked resolved secrets into etcd (M2/2b-ii).

## Notes
- `@frak/atelier-shared` is NOT v1 — it is the shared package the v2 server,
  spec, and agent all use (`config.schema.ts`, `constants`, `agent.schema.ts`).
  Keep.
- Deleting `apps/manager` + `apps/dashboard` will also clear the 8 pre-existing
  whole-repo `biome` errors (all v1 legacy in those trees + `infra`).
