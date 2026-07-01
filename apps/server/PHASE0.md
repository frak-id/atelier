# Phase 0 — known scoped gaps

Deliberate, documented deferrals in the initial `apps/server` build. None of
these block the runtime/control/sessions seam from working; each has a named
follow-up milestone in `docs/proposals/atelier-v2.md` (§6).

1. **GitHub OAuth login route is not wired.** `control/github-oauth.ts` and
   `control/authorization-policy.ts` implement the PKCE exchange and the
   org/allowlist gate, but no `api/` route drives them end-to-end and mints a
   JWT yet. Non-mock browser auth cannot obtain a session today. `atl_` API
   keys (`control/modules/api-key`) and mock mode (`isMock()`) both work now.
   Login/GUI is proposal §6 milestone 5 ("GUI v2 — the primary product").

2. **No per-sandbox ownership/authz check on `/v1/sandboxes/:id/*` routes.**
   Any authenticated caller can act on any sandbox id — the runtime store has
   no FK to any identity table by design (atelier-v2 §3.1: "callers are just
   'authenticated principals' to it"). Tagging sandboxes with an owner/org at
   create time and checking it in `api/` before delegating to `runtime.*` is a
   follow-up before multi-tenant exposure.

3. **`readiness` (`http`/`cmd`), `primary`, `after`, `restart`, `stdio` are not
   yet load-bearing in boot.** `runtime/spec-to-config.ts` maps `processes[]`
   onto the v1 agent's flat `services` record (only `readiness.port` survives,
   via `SandboxServiceEntry.port`); boot readiness gates on pod-level agent
   health, not the spec's `primary` process. Deferred to the v2 agent line
   (§6 milestone 1), which the seam is documented to depend on.

4. **`prebuild()`'s `build[]`/`repos` execution is deferred to milestone 4.**
   The content-hash keying and chaining (`parent`) are already correct and
   idempotent; provisioning a temp pod to actually run build steps and
   snapshot the result is not yet wired.

5. **The runtime store is in-memory** (`runtime/store.ts`). A server restart
   drops all sandbox/snapshot bookkeeping, orphaning any still-running pods,
   until a persistent `SandboxStore` implementation lands.

6. **MCP tools have no per-caller identity.** `api/mcp.routes.ts` auth
   (`verifyMcpAuth`) is a single static bearer token, not a per-user session,
   so `create_sandbox` cannot resolve an `orgId` for enrichment yet —
   org-scoped secrets/policy are unreachable via MCP until MCP auth carries a
   user identity.
