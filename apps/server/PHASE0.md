# Phase 0 — known scoped gaps

Deliberate, documented deferrals in the initial `apps/server` build. None of
these block the runtime/control/sessions seam from working; each has a named
follow-up milestone in `docs/proposals/atelier-v2.md` (§6).

1. **GitHub OAuth login is wired** (`api/auth.routes.ts`): `GET /auth/github`
   (mock auto-login, or real PKCE redirect) and `GET /auth/callback` (code
   exchange → `isUserAuthorized` gate → user upsert → personal-org bootstrap →
   `signJwt` → `sandbox_token` cookie) mint the JWT the rest of `/v1`, `/api`,
   `/sessions` require, plus `/auth/me`, `/auth/verify`, `/auth/logout`,
   `/auth/api-token`. `atl_` API keys and mock mode both still work.
   **Still a follow-up, not covered by this route**: forward-auth for tool
   ingresses (v1's `GET /auth/opencode/verify`, which injects Basic-auth for
   Traefik's `authResponseHeaders`) is out of scope here and unwired — the
   ingress-level auth story for exposed ports (`atelier-v2` §2 `auth:
   "forward"`) is a separate follow-up, not this login flow.

2. **No per-sandbox ownership/authz check on `/v1/sandboxes/:id/*` routes.**
   Any authenticated caller can act on any sandbox id — the runtime store has
   no FK to any identity table by design (atelier-v2 §3.1: "callers are just
   'authenticated principals' to it"). Tagging sandboxes with an owner/org at
   create time and checking it in `api/` before delegating to `runtime.*` is a
   follow-up before multi-tenant exposure.

3. **RESOLVED (M1 + M2).** The full process model (`readiness` http/cmd,
   `primary`, `after`, `restart`, `stdio`, `pty`, `lazy`, `user`) is now
   load-bearing: `runtime/agent-config.ts` losslessly projects it onto the v2
   agent (`apps/agent-v2`), boot pushes it via `PUT /config` + `files/write`
   and gates on the spec's `primary` process readiness (`/health`), not
   pod-level health. Remaining v2-agent wiring (deploy image, `/processes/*`
   + unified-attach live-ops routes) is M2/2c.

4. **`prebuild()`'s `build[]`/`repos` execution is deferred to milestone 4.**
   The content-hash keying and chaining (`parent`) are already correct and
   idempotent; provisioning a temp pod to actually run build steps and
   snapshot the result is not yet wired.

5. **~~The runtime store is in-memory~~ — DONE.** `runtime/store.ts` now
   persists to SQLite via drizzle (`DrizzleSandboxStore`/`DrizzleSnapshotStore`,
   sharing `server.db` with control through `shared/lib/db.ts`). The
   `InMemory*` stores remain for tests/standalone use.

6. **RESOLVED.** `api/mcp/` now resolves the caller through
   `control.authService.resolveToken` (the same `atl_` API-key / JWT path
   every other route uses) instead of a single static bearer token. Each MCP
   session is bound to the user who initialized it, so `create_sandbox`
   (via the shared `createSandboxForUser`, also used by `POST /v1/sandboxes`)
   resolves `orgId` and applies org-scoped secrets/policy/toolboxes exactly
   like the HTTP/CLI/GUI path.
