# Caddy Forward Auth for Sandbox Routes

## TL;DR

> **Quick Summary**: Add JWT-based authentication to all Caddy sandbox routes using forward_auth pattern (translated to Caddy JSON API). Caddy verifies each request by calling the manager's `/auth/verify` endpoint before proxying to the sandbox VM.
>
> **Deliverables**:
> - `GET /auth/verify` endpoint on manager API
> - Cookie-based auth (`sandbox_token`) set on parent domain
> - Modified `CaddyService.addRouteDirect()` with forward_auth handler
> - Dashboard cookie setting on login
> - Updated `/auth/callback` to set HttpOnly cookie
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 1 → Task 2 → Task 3 → Task 4

---

## Context

### Original Request
All sandbox subdomains (vscode, opencode, terminal, dev, browser) are publicly accessible. Anyone who knows the URL gets full access. Need Caddy to verify the user's JWT before proxying requests to sandbox VMs.

### Interview Summary
**Key Discussions**:
- Cookie: `sandbox_token`, `HttpOnly; Secure; SameSite=None; Path=/; Domain=.{domainSuffix}`
- `/auth/verify` accepts BOTH cookie (first) and Authorization header (fallback)
- No tests — manual verification via curl
- Mock mode skips forward_auth handler entirely (no auth handler in route config)
- Wildcard fallback route does NOT get auth

**Research Findings**:
- `addRouteDirect()` is the single point for all route configs — modifying it covers vscode, opencode, terminal, dev, and browser routes
- `verifyJwt()` in `apps/manager/src/shared/lib/auth.ts:12-26` uses jose library, can be reused directly
- `authRoutes` is mounted at line 195 in `index.ts`, BEFORE the `/api` authGuard group — `/auth/verify` can be added here
- No existing cookie handling in the manager codebase
- Elysia uses `cookie` context property for cookie access: `({ cookie }) => { cookie.sandbox_token.set({ value, httpOnly, ... }) }`
- `config.caddy.domainSuffix` holds the parent domain (default: `localhost`)
- Dashboard domain is separate (`sandbox-dash.localhost` by default) from sandbox suffix (`localhost`)

### Metis Review
**Identified Gaps** (addressed):
- **Logout flow**: Cookie clears naturally on expiry (7 days, matching JWT). Dashboard `clearAuthToken()` should also clear the cookie. Added to Task 4.
- **Dev vs production cookies**: `Secure` flag breaks HTTP localhost. Plan conditionally sets `Secure` only in production mode. Added to Task 1.
- **Token mismatch (expired cookie, valid localStorage)**: Dashboard should re-set cookie whenever it has a valid token. Added to Task 4.
- **Caddy 401 behavior**: When forward_auth returns 401, Caddy returns the 401 response to the client. Browser gets 401. This is acceptable — dashboard handles re-auth.
- **Mock mode `/auth/verify`**: Endpoint always works (verifies JWT normally). Only the Caddy forward_auth handler is skipped in mock mode.

---

## Work Objectives

### Core Objective
Protect all sandbox subdomain routes behind JWT authentication via Caddy's forward_auth pattern, using cookies for seamless cross-subdomain auth.

### Concrete Deliverables
- `GET /auth/verify` endpoint returning 200/401
- `sandbox_token` HttpOnly cookie set on `.{domainSuffix}`
- Forward auth handler prepended to all Caddy sandbox route configs
- Dashboard sets/clears `sandbox_token` cookie alongside localStorage

### Definition of Done
- [ ] `curl -H "Cookie: sandbox_token=VALID_JWT" https://sandbox-xxx.domain/` → proxied to VM
- [ ] `curl https://sandbox-xxx.domain/` (no cookie/header) → 401
- [ ] `curl -H "Authorization: Bearer VALID_JWT" https://sandbox-xxx.domain/` → proxied to VM
- [ ] WebSocket connections (terminal, vscode) work with cookie auth
- [ ] Dashboard login sets cookie, sandbox routes accessible immediately

### Must Have
- Cookie checked before Authorization header in `/auth/verify`
- Forward auth handler BEFORE upstream handler in Caddy route config
- Cookie domain is `.{domainSuffix}` (parent domain, shared across all subdomains)
- Mock mode does NOT add forward_auth handler to route configs
- Wildcard fallback route has NO forward_auth

### Must NOT Have (Guardrails)
- NO database queries in `/auth/verify` — JWT verification only
- NO token refresh mechanism (out of scope)
- NO per-sandbox access control (any valid user can access any sandbox)
- NO modification to existing `authGuard` function
- NO changes to the wildcard fallback route
- DO NOT break existing `Authorization: Bearer` flow for dashboard API calls

---

## Verification Strategy (MANDATORY)

### Test Decision
- **Infrastructure exists**: NO
- **User wants tests**: NO — manual verification only
- **Framework**: none

### Manual Verification Procedures

Each task includes specific curl commands and verification steps that the agent can execute.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately):
├── Task 1: /auth/verify endpoint + cookie setting in /auth/callback
└── Task 2: CaddyService forward_auth handler modification

Wave 2 (After Wave 1):
├── Task 3: Integration verification (curl tests against running server)
└── Task 4: Dashboard cookie management
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 | None | 3 | 2 |
| 2 | None | 3 | 1 |
| 3 | 1, 2 | 4 | None |
| 4 | 1 | None | 3 (loosely) |

### Agent Dispatch Summary

| Wave | Tasks | Recommended Agents |
|------|-------|-------------------|
| 1 | 1, 2 | delegate_task(category="quick", run_in_background=true) each |
| 2 | 3 | delegate_task(category="quick", run_in_background=false) |
| 2 | 4 | delegate_task(category="quick", run_in_background=true) |

---

## TODOs

- [ ] 1. Add `/auth/verify` endpoint and cookie setting to `/auth/callback`

  **What to do**:

  **1a. Export `verifyJwt` from `auth.ts`**
  - In `apps/manager/src/shared/lib/auth.ts`, change `async function verifyJwt` to `export async function verifyJwt` (line 12). It's currently private, used only by `authGuard`.

  **1b. Add `GET /auth/verify` to `auth.routes.ts`**
  - Add a new route inside the existing `authRoutes` Elysia plugin (which is already outside authGuard).
  - The endpoint:
    1. Reads `sandbox_token` from cookie (using Elysia's `cookie` context)
    2. Falls back to `Authorization: Bearer` header
    3. Calls `verifyJwt(token)` from `shared/lib/auth.ts`
    4. Returns 200 with `{ ok: true }` if valid
    5. Returns 401 with `{ error: "UNAUTHORIZED" }` if invalid/missing
  - Implementation sketch:
    ```typescript
    .get("/verify", async ({ cookie, headers, set }) => {
      const token = cookie.sandbox_token?.value
        || headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

      if (!token) {
        set.status = 401;
        return { error: "UNAUTHORIZED", message: "No token provided" };
      }

      const user = await verifyJwt(token);
      if (!user) {
        set.status = 401;
        return { error: "UNAUTHORIZED", message: "Invalid or expired token" };
      }

      return { ok: true, user: user.username };
    })
    ```
  - Import `verifyJwt` from `../shared/lib/auth.ts`

  **1c. Set cookie in `/auth/callback`**
  - After successfully signing the JWT (line 58-62 in auth.routes.ts), set the `sandbox_token` cookie:
    ```typescript
    cookie.sandbox_token.set({
      value: token,
      httpOnly: true,
      secure: config.isProduction(),
      sameSite: config.isProduction() ? "none" : "lax",
      path: "/",
      domain: `.${config.caddy.domainSuffix}`,
      maxAge: JWT_EXPIRY_SECONDS,
    });
    ```
  - Note: `secure: true` and `sameSite: "none"` only in production (HTTPS). In dev/mock mode, use `secure: false` and `sameSite: "lax"` to avoid localhost cookie issues.
  - The existing `?login_token=` redirect stays as-is (dashboard still needs it for localStorage).

  **Must NOT do**:
  - Do NOT add database queries to `/auth/verify`
  - Do NOT modify the existing `authGuard` function
  - Do NOT add `/auth/verify` inside the `/api` group

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Straightforward endpoint addition following existing patterns in auth.routes.ts
  - **Skills**: []
    - No special skills needed — pure TypeScript route handler
  - **Skills Evaluated but Omitted**:
    - `playwright`: No browser testing needed
    - `frontend-ui-ux`: Backend-only task

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: Task 3
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `apps/manager/src/api/auth.routes.ts:80-104` — `/auth/me` endpoint pattern (JWT extraction from Authorization header). Follow this exact pattern for header fallback.
  - `apps/manager/src/api/auth.routes.ts:33-79` — `/auth/callback` handler. This is where cookie setting goes, after `jwt.sign()` on line 58.
  - `apps/manager/src/api/auth.routes.ts:17-24` — Elysia JWT plugin setup. The `/auth/verify` route is within this same plugin, so `jwt` context is available but NOT needed (use `verifyJwt` from auth.ts instead for consistency).

  **API/Type References**:
  - `apps/manager/src/shared/lib/auth.ts:12-26` — `verifyJwt()` function. Currently NOT exported. Must be exported. Returns `AuthUser | null`.
  - `apps/manager/src/shared/lib/auth.ts:6-10` — `AuthUser` interface (already exported).
  - `apps/manager/src/shared/lib/config.ts:25-28` — `config.caddy.domainSuffix` for cookie domain.
  - `apps/manager/src/shared/lib/config.ts:48-49` — `config.isProduction()` and `config.isMock()` for conditional cookie flags.

  **Documentation References**:
  - `apps/manager/src/index.ts:194-195` — Shows `authRoutes` mounted BEFORE `/api` authGuard group. Confirms `/auth/verify` will be outside auth.

  **WHY Each Reference Matters**:
  - `auth.routes.ts:80-104`: Shows exact pattern for extracting Bearer token. Reuse the regex pattern.
  - `auth.routes.ts:33-79`: This is the function you're modifying to add cookie setting. Understand the flow: exchangeCode → fetchUser → isAuthorized → jwt.sign → redirect.
  - `auth.ts:12-26`: This is the core verification function. Must be exported to be used by the new endpoint.
  - `config.ts:25-28`: The `domainSuffix` value (default `localhost`) becomes `.localhost` for the cookie domain.

  **Acceptance Criteria**:

  ```bash
  # Start the manager in mock mode
  SANDBOX_MODE=mock bun run dev

  # 1. Verify /auth/verify returns 401 with no token
  curl -s -o /dev/null -w "%{http_code}" http://localhost:4000/auth/verify
  # Assert: 401

  # 2. Verify /auth/verify returns 401 with invalid token
  curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer invalid" http://localhost:4000/auth/verify
  # Assert: 401

  # 3. Verify /auth/verify returns 200 with valid token via header
  # (First obtain a valid JWT by checking existing /auth/me or signing one manually)
  TOKEN=$(bun -e "
    import * as jose from 'jose';
    const secret = new TextEncoder().encode(process.env.FRAK_JWT_SECRET || 'dev-secret');
    const jwt = await new jose.SignJWT({ sub: '1', username: 'test', avatarUrl: '' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(secret);
    console.log(jwt);
  ")
  curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" http://localhost:4000/auth/verify
  # Assert: 200

  # 4. Verify /auth/verify returns 200 with valid token via cookie
  curl -s -o /dev/null -w "%{http_code}" -b "sandbox_token=$TOKEN" http://localhost:4000/auth/verify
  # Assert: 200

  # 5. Verify cookie takes precedence: valid cookie + invalid header → 200
  curl -s -o /dev/null -w "%{http_code}" -b "sandbox_token=$TOKEN" -H "Authorization: Bearer invalid" http://localhost:4000/auth/verify
  # Assert: 200
  ```

  **Evidence to Capture:**
  - [ ] Terminal output from all 5 curl commands showing expected status codes

  **Commit**: YES
  - Message: `feat(auth): add /auth/verify endpoint and set sandbox_token cookie on login`
  - Files: `apps/manager/src/api/auth.routes.ts`, `apps/manager/src/shared/lib/auth.ts`
  - Pre-commit: `bun run check && bun run typecheck`

---

- [ ] 2. Modify CaddyService to prepend forward_auth handler to sandbox routes

  **What to do**:

  **2a. Add `buildForwardAuthHandler()` helper to `caddy.service.ts`**
  - Add a private helper function that returns the forward_auth reverse_proxy JSON config:
    ```typescript
    function buildForwardAuthHandler(): object {
      return {
        handler: "reverse_proxy",
        upstreams: [{ dial: `${config.host}:${config.port}` }],
        rewrite: {
          method: "GET",
          uri: "/auth/verify",
        },
        headers: {
          request: {
            set: {
              "X-Forwarded-Method": ["{http.request.method}"],
              "X-Forwarded-Uri": ["{http.request.uri}"],
            },
          },
        },
        handle_response: [
          {
            match: { status_code: [2] },
            routes: [
              {
                handle: [
                  {
                    handler: "headers",
                    request: { set: {} },
                  },
                ],
              },
            ],
          },
        ],
      };
    }
    ```
  - The `dial` address should be `localhost:4000` (or use `config.host:config.port` for flexibility).
  - The `handle_response` block: status code range `[2]` means any 2xx = success. If NOT 2xx, Caddy returns the upstream response (401) to the client.

  **2b. Modify `addRouteDirect()` to prepend the auth handler**
  - In `addRouteDirect()` (line 69-101), prepend the forward_auth handler to the `handle` array:
    ```typescript
    async addRouteDirect(route: RouteDefinition): Promise<void> {
      await this.removeRoute(route.domain);

      const handlers: object[] = [];

      // Prepend forward_auth handler (skip in mock mode)
      if (!config.isMock()) {
        handlers.push(buildForwardAuthHandler());
      }

      // Actual upstream proxy
      handlers.push({
        handler: "reverse_proxy",
        upstreams: [{ dial: route.upstream }],
        transport: { protocol: "http", read_buffer_size: 4096 },
        flush_interval: -1,
      });

      const routeConfig = {
        "@id": route.domain,
        match: [{ host: [route.domain] }],
        handle: handlers,
        terminal: true,
      };

      // ... existing POST to Caddy admin API
    }
    ```
  - Note: The `config.isMock()` check is technically redundant here because `addRouteDirect()` is only called from `addRoutes()` which is only called when NOT in mock mode (mock mode returns early in `registerRoutes`). However, adding the check is a safety guardrail in case future code paths bypass the mock check.

  **2c. Do NOT modify `addWildcardFallback()`**
  - The wildcard route (line 197-228) returns a 502 static response. It intentionally has no auth — unauthenticated users hitting unknown subdomains should get 502, not 401.

  **Must NOT do**:
  - Do NOT modify `addWildcardFallback()`
  - Do NOT modify `removeRoute()`, `removeRoutes()`, or any other methods
  - Do NOT change the upstream reverse_proxy handler config
  - Do NOT add auth to the wildcard fallback route

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Focused modification to a single method in a single file
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: No browser needed

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: Task 3
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `apps/manager/src/infrastructure/proxy/caddy.service.ts:69-101` — Current `addRouteDirect()` method. This is the ONLY method to modify. Shows existing route config structure.
  - `apps/manager/src/infrastructure/proxy/caddy.service.ts:197-228` — `addWildcardFallback()`. DO NOT TOUCH. Reference to understand what should NOT get auth.
  - `apps/manager/src/infrastructure/proxy/caddy.service.ts:51-67` — `addRoutes()` showing the wildcard-remove-add-reAdd pattern. Understand this to verify auth handler doesn't break the flow.

  **API/Type References**:
  - `apps/manager/src/infrastructure/proxy/caddy.service.ts:6-9` — `RouteDefinition` interface. No changes needed.
  - `apps/manager/src/shared/lib/config.ts:18-52` — Config object with `config.host`, `config.port`, `config.isMock()`.

  **External References**:
  - Caddy JSON reverse_proxy handler docs: The `handle_response` with `status_code: [2]` matcher is the JSON equivalent of `forward_auth`. Range `[2]` means "any status starting with 2" (200-299).

  **WHY Each Reference Matters**:
  - `caddy.service.ts:69-101`: The exact function being modified. Understand the existing handler structure to prepend correctly.
  - `caddy.service.ts:197-228`: Must NOT be modified. Verify you understand the wildcard is separate.
  - `config.ts:18-52`: Need `config.port` and `config.host` for the auth handler's upstream dial address.

  **Acceptance Criteria**:

  ```bash
  # Start manager in mock mode and verify route config generation
  # Since mock mode skips Caddy, verify by inspecting the code logic:

  # 1. Verify typecheck passes
  bun run typecheck
  # Assert: Exit code 0

  # 2. Verify lint passes
  bun run check
  # Assert: Exit code 0

  # 3. In production mode, verify the route config includes forward_auth
  # (This is validated in Task 3 integration test against real/mock Caddy)
  ```

  **Evidence to Capture:**
  - [ ] `bun run typecheck` passes
  - [ ] `bun run check` passes

  **Commit**: YES
  - Message: `feat(caddy): prepend forward_auth handler to sandbox route configs`
  - Files: `apps/manager/src/infrastructure/proxy/caddy.service.ts`
  - Pre-commit: `bun run check && bun run typecheck`

---

- [ ] 3. Integration verification — end-to-end auth flow

  **What to do**:

  **3a. Verify forward_auth handler structure in Caddy**
  - Start the manager in production mode (or with a local Caddy instance)
  - Create a sandbox (or manually POST a route to Caddy)
  - Fetch the Caddy config and verify the route has TWO handlers: auth + upstream

  **3b. Verify the full auth flow**
  - Request a sandbox route with no auth → expect 401
  - Request with valid cookie → expect proxied response
  - Request with valid Authorization header → expect proxied response
  - WebSocket upgrade with cookie → expect connection established

  **3c. Verify mock mode has no auth handler**
  - Start in mock mode
  - Verify `addRouteDirect()` does not include the forward_auth handler
  - This can be verified by adding a temporary log or by inspecting the route config

  **Must NOT do**:
  - Do NOT modify any source code in this task
  - This is purely a verification/testing task

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Verification only — curl commands and log inspection
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential)
  - **Blocks**: None (Task 4 can run loosely in parallel)
  - **Blocked By**: Tasks 1, 2

  **References**:

  **Pattern References**:
  - `apps/manager/src/infrastructure/proxy/caddy.service.ts:323-348` — `getConfig()` and `getRoutes()` methods for inspecting Caddy state via admin API.

  **WHY Each Reference Matters**:
  - `getRoutes()`: Use this to verify the route config has the forward_auth handler after registration.

  **Acceptance Criteria**:

  ```bash
  # 1. Start manager
  SANDBOX_MODE=mock bun run dev &
  sleep 2

  # 2. Generate a valid JWT for testing
  TOKEN=$(bun -e "
    import * as jose from 'jose';
    const secret = new TextEncoder().encode(process.env.FRAK_JWT_SECRET || 'dev-secret');
    const jwt = await new jose.SignJWT({ sub: '1', username: 'test', avatarUrl: '' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(secret);
    console.log(jwt);
  ")

  # 3. Verify /auth/verify works with cookie
  curl -s -w "\n%{http_code}" -b "sandbox_token=$TOKEN" http://localhost:4000/auth/verify
  # Assert: 200, body contains { "ok": true }

  # 4. Verify /auth/verify works with header
  curl -s -w "\n%{http_code}" -H "Authorization: Bearer $TOKEN" http://localhost:4000/auth/verify
  # Assert: 200

  # 5. Verify /auth/verify rejects no token
  curl -s -w "\n%{http_code}" http://localhost:4000/auth/verify
  # Assert: 401

  # 6. Verify /auth/verify rejects expired token
  EXPIRED=$(bun -e "
    import * as jose from 'jose';
    const secret = new TextEncoder().encode(process.env.FRAK_JWT_SECRET || 'dev-secret');
    const jwt = await new jose.SignJWT({ sub: '1', username: 'test', avatarUrl: '' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('0s')
      .sign(secret);
    console.log(jwt);
  ")
  sleep 1
  curl -s -w "\n%{http_code}" -b "sandbox_token=$EXPIRED" http://localhost:4000/auth/verify
  # Assert: 401

  # 7. Verify typecheck and lint still pass
  bun run check && bun run typecheck
  # Assert: Exit code 0
  ```

  **Evidence to Capture:**
  - [ ] All curl responses with status codes
  - [ ] typecheck + lint pass

  **Commit**: NO (verification only)

---

- [ ] 4. Dashboard cookie management — set and clear `sandbox_token`

  **What to do**:

  **4a. Add cookie utility functions to `apps/dashboard/src/api/client.ts`**
  - Add helper functions for setting and clearing the `sandbox_token` cookie:
    ```typescript
    const SANDBOX_COOKIE_NAME = "sandbox_token";

    export function setSandboxCookie(token: string): void {
      // Set cookie on parent domain for cross-subdomain access
      // Domain must match what the server sets
      document.cookie = `${SANDBOX_COOKIE_NAME}=${token}; path=/; domain=.${window.location.hostname.split('.').slice(-2).join('.')}; max-age=${7 * 24 * 60 * 60}; secure; samesite=none`;
    }

    export function clearSandboxCookie(): void {
      document.cookie = `${SANDBOX_COOKIE_NAME}=; path=/; domain=.${window.location.hostname.split('.').slice(-2).join('.')}; max-age=0; secure; samesite=none`;
    }
    ```
  - Note: The domain extraction (`window.location.hostname.split('.').slice(-2).join('.')`) gets the parent domain dynamically. E.g., `sandbox-dash.nivelais.com` → `.nivelais.com`. This must match the server-side cookie domain.
  - **Alternative approach**: Add `VITE_COOKIE_DOMAIN` env var to `apps/dashboard/src/config.ts` for explicit control. This is safer than domain extraction. The env var would match `config.caddy.domainSuffix` on the server.

  **4b. Set cookie on login in `login-page.tsx`**
  - In `apps/dashboard/src/components/login-page.tsx`, after `setAuthToken(loginToken)` (line 22), also call `setSandboxCookie(loginToken)`:
    ```typescript
    if (loginToken) {
      setAuthToken(loginToken);
      setSandboxCookie(loginToken);
      window.history.replaceState({}, "", window.location.pathname);
      onLoginSuccess();
      return;
    }
    ```

  **4c. Clear cookie on logout**
  - Find where `clearAuthToken()` is called and also call `clearSandboxCookie()` alongside it.
  - Search for `clearAuthToken` usage in the dashboard codebase.

  **4d. Add `VITE_COOKIE_DOMAIN` to dashboard config**
  - In `apps/dashboard/src/config.ts`, add:
    ```typescript
    export const COOKIE_DOMAIN = import.meta.env.VITE_COOKIE_DOMAIN || "";
    ```
  - Use this in the cookie helpers instead of dynamic domain extraction if set.

  **Must NOT do**:
  - Do NOT remove the existing localStorage-based auth flow (it's still used for API calls)
  - Do NOT modify the Eden Treaty client setup
  - Do NOT add any API calls — this is client-side cookie manipulation only

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small React/TS changes across 2-3 files
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: No UI changes, just cookie logic
    - `playwright`: Manual verification sufficient

  **Parallelization**:
  - **Can Run In Parallel**: YES (loosely, after Task 1)
  - **Parallel Group**: Wave 2 (with Task 3)
  - **Blocks**: None
  - **Blocked By**: Task 1 (needs to know cookie name/format)

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/api/client.ts:7-19` — Existing `getAuthToken()`, `setAuthToken()`, `clearAuthToken()` functions. Follow this pattern for cookie helpers.
  - `apps/dashboard/src/components/login-page.tsx:16-26` — Login token handling from query params. This is where `setSandboxCookie()` goes.

  **API/Type References**:
  - `apps/dashboard/src/config.ts:1-13` — Dashboard config with env vars. Add `VITE_COOKIE_DOMAIN` here.

  **WHY Each Reference Matters**:
  - `client.ts:7-19`: Shows the naming convention (`AUTH_TOKEN_KEY`, `get/set/clear` pattern). Mirror this for cookie functions.
  - `login-page.tsx:16-26`: Exact location where token is received and stored. Add cookie setting here.
  - `config.ts`: Where to add the cookie domain env var.

  **Acceptance Criteria**:

  ```bash
  # 1. Verify typecheck passes
  bun run typecheck
  # Assert: Exit code 0

  # 2. Verify lint passes
  bun run check
  # Assert: Exit code 0

  # 3. Verify build succeeds
  bun run build --filter=@frak-sandbox/dashboard
  # Assert: Exit code 0
  ```

  **Evidence to Capture:**
  - [ ] typecheck + lint + build pass

  **Commit**: YES
  - Message: `feat(dashboard): set sandbox_token cookie on login for subdomain auth`
  - Files: `apps/dashboard/src/api/client.ts`, `apps/dashboard/src/components/login-page.tsx`, `apps/dashboard/src/config.ts`
  - Pre-commit: `bun run check && bun run typecheck`

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1 | `feat(auth): add /auth/verify endpoint and set sandbox_token cookie on login` | `auth.routes.ts`, `auth.ts` | `bun run check && bun run typecheck` |
| 2 | `feat(caddy): prepend forward_auth handler to sandbox route configs` | `caddy.service.ts` | `bun run check && bun run typecheck` |
| 3 | (no commit — verification only) | — | — |
| 4 | `feat(dashboard): set sandbox_token cookie on login for subdomain auth` | `client.ts`, `login-page.tsx`, `config.ts` | `bun run check && bun run typecheck` |

---

## Success Criteria

### Verification Commands
```bash
# Full project checks
bun run check       # Expected: no errors
bun run typecheck   # Expected: no errors

# Auth verify endpoint
curl -s -w "%{http_code}" http://localhost:4000/auth/verify          # Expected: 401
curl -s -w "%{http_code}" -b "sandbox_token=VALID" http://localhost:4000/auth/verify  # Expected: 200
curl -s -w "%{http_code}" -H "Authorization: Bearer VALID" http://localhost:4000/auth/verify  # Expected: 200
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] `bun run check` passes
- [ ] `bun run typecheck` passes
- [ ] `/auth/verify` returns 200 for valid JWT (cookie and header)
- [ ] `/auth/verify` returns 401 for missing/invalid JWT
- [ ] Cookie set on `.{domainSuffix}` after login callback
- [ ] Caddy route configs include forward_auth handler (production mode)
- [ ] Caddy route configs do NOT include forward_auth handler (mock mode)
- [ ] Wildcard fallback route unchanged
- [ ] Dashboard sets `sandbox_token` cookie on login
