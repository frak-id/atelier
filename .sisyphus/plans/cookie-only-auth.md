# Cookie-Only Auth: Remove Header-Based Auth Entirely

## TL;DR

> **Quick Summary**: Remove all `Authorization: Bearer` header-based auth from both Manager API and Dashboard. Use HttpOnly `sandbox_token` cookie everywhere — Elysia's built-in reactive cookies on the server, `credentials: "include"` on the client.
> 
> **Deliverables**:
> - Manager API reads auth exclusively from cookies (no header fallback)
> - New `POST /auth/logout` endpoint to clear HttpOnly cookie
> - CORS configured for credentials support
> - Dashboard uses no localStorage/client-side cookies for auth
> - Eden Treaty sends cookies automatically via `credentials: "include"`
> 
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 1 (Manager API) → Task 2 (Dashboard client) → Task 3 (Dashboard UI)

---

## Context

### Original Request
Remove header-based auth entirely and use cookies everywhere. The forward_auth implementation already set up the `sandbox_token` HttpOnly cookie. Now we complete the migration by removing all header/localStorage auth paths.

### Current State
- `/auth/callback` sets cookie AND returns `?login_token=` query param
- `/auth/me` reads `Authorization: Bearer` header only
- `/auth/verify` reads cookie first, header fallback
- `authGuard` reads `Authorization: Bearer` header
- Dashboard stores JWT in localStorage, sends `Authorization` header
- Dashboard sets client-side cookies manually

### Target State
- All auth reads from `cookie.sandbox_token` only
- No header fallback anywhere
- Dashboard has zero localStorage auth logic
- New server-side logout endpoint (HttpOnly cookies can't be cleared from JS)
- CORS must allow credentials with explicit origin

---

## Work Objectives

### Core Objective
Unify auth to cookie-only across the entire stack, eliminating header-based auth and localStorage token storage.

### Concrete Deliverables
- Modified `auth.ts`, `auth.routes.ts`, `index.ts` in Manager
- Modified `client.ts`, `login-page.tsx`, `__root.tsx`, `config.ts` in Dashboard
- New `POST /auth/logout` endpoint

### Definition of Done
- [ ] No occurrence of `Authorization` header reading in auth code
- [ ] No occurrence of `localStorage` auth token in dashboard
- [ ] No client-side cookie manipulation in dashboard
- [ ] `POST /auth/logout` clears cookie and returns 200
- [ ] CORS configured with `credentials: true` and explicit origin
- [ ] `bun run check` passes
- [ ] `bun run typecheck` passes

### Must Have
- HttpOnly cookie auth on all protected endpoints
- Server-side logout endpoint
- CORS credentials support with explicit origin
- `credentials: "include"` on Eden Treaty

### Must NOT Have (Guardrails)
- NO `Authorization: Bearer` header reading in any auth path
- NO `localStorage.getItem/setItem` for auth tokens
- NO client-side `document.cookie` manipulation
- NO `?login_token=` query parameter in callback redirect
- NO wildcard `*` CORS origin (breaks credentials)
- NO new npm/bun dependencies (Elysia cookies are built-in)

---

## Verification Strategy

### Test Decision
- **Infrastructure exists**: NO (no test framework)
- **User wants tests**: Manual verification
- **Framework**: none

### Automated Verification

```bash
# 1. No header auth remaining in manager auth code
grep -r "authorization" apps/manager/src/shared/lib/auth.ts apps/manager/src/api/auth.routes.ts && echo "FAIL: header auth still present" || echo "PASS"

# 2. No localStorage auth in dashboard
grep -r "localStorage" apps/dashboard/src/ && echo "FAIL: localStorage still used" || echo "PASS"

# 3. No client-side cookie manipulation in dashboard
grep -r "document.cookie" apps/dashboard/src/ && echo "FAIL: document.cookie still used" || echo "PASS"

# 4. No login_token query param
grep -r "login_token" apps/manager/src/ apps/dashboard/src/ && echo "FAIL: login_token still referenced" || echo "PASS"

# 5. Typecheck passes
bun run typecheck

# 6. Lint passes
bun run check
```

---

## Task Dependency Graph

| Task | Depends On | Reason |
|------|------------|--------|
| Task 1 | None | Manager API changes are independent |
| Task 2 | Task 1 | Dashboard client must match new API contract (cookie auth, no header) |
| Task 3 | Task 2 | Dashboard UI depends on new client functions (`checkAuth`, `logout`) |

## Parallel Execution Graph

```
Wave 1 (Start immediately):
└── Task 1: Manager API - cookie-only auth + logout endpoint + CORS

Wave 2 (After Wave 1):
├── Task 2: Dashboard client - remove localStorage/headers, add credentials
└── Task 3: Dashboard UI - login page + root layout (can parallel with Task 2 since changes are in different files, but logically Task 3 imports from Task 2)

Note: Tasks 2 and 3 touch different files but Task 3 imports functions from Task 2's file.
So they must be sequential: Task 2 → Task 3.

Critical Path: Task 1 → Task 2 → Task 3
```

## Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 | None | 2, 3 | None |
| 2 | 1 | 3 | None |
| 3 | 2 | None | None |

## Agent Dispatch Summary

| Wave | Tasks | Recommended Agents |
|------|-------|-------------------|
| 1 | 1 | `category="quick", skills=["typescript-programmer"]` |
| 2 | 2, 3 (sequential) | `category="quick", skills=["typescript-programmer"]` |

---

## TODOs

- [ ] 1. Manager API: Cookie-only auth + logout endpoint + CORS credentials

  **What to do**:

  **1a. `apps/manager/src/shared/lib/auth.ts` — authGuard reads cookie**:
  - Replace `headers` parameter with `cookie` parameter
  - Read token from `cookie.sandbox_token.value` (Elysia reactive cookie)
  - Remove all `Authorization` header parsing
  - New signature:
    ```typescript
    export async function authGuard({
      cookie, set, store,
    }: {
      cookie: Record<string, any>;
      set: { status?: number | string };
      store: { user?: AuthUser } & Record<string, unknown>;
    })
    ```
  - Get token: `const token = cookie.sandbox_token?.value;`
  - If no token → 401 "Missing authentication cookie"
  - Verify with `verifyJwt(token)`, set `store.user`

  **1b. `apps/manager/src/api/auth.routes.ts`**:
  - `/auth/callback`: Change redirect from `${config.dashboardUrl}?login_token=${token}` to just `${config.dashboardUrl}` (cookie is already set above)
  - `/auth/me`: Replace header reading with cookie reading:
    ```typescript
    .get("/me", async ({ cookie, jwt, set }) => {
      const token = cookie.sandbox_token?.value;
      if (!token) { set.status = 401; return { error: "UNAUTHORIZED", message: "Missing authentication cookie" }; }
      const payload = await jwt.verify(token);
      if (!payload) { set.status = 401; return { error: "UNAUTHORIZED", message: "Invalid or expired token" }; }
      return { id: payload.sub, username: payload.username, avatarUrl: payload.avatarUrl };
    })
    ```
  - `/auth/verify`: Remove header fallback — read `cookie.sandbox_token.value` only
  - **Add** `POST /auth/logout`:
    ```typescript
    .post("/logout", ({ cookie, set }) => {
      cookie.sandbox_token?.set({
        value: "",
        httpOnly: true,
        secure: config.isProduction(),
        sameSite: config.isProduction() ? "none" : "lax",
        path: "/",
        domain: `.${config.caddy.domainSuffix}`,
        maxAge: 0,
      });
      return { ok: true };
    })
    ```

  **1c. `apps/manager/src/index.ts` — CORS with credentials**:
  - Change `.use(cors())` to:
    ```typescript
    .use(cors({
      origin: config.dashboardUrl,
      credentials: true,
    }))
    ```
  - The `authGuard` is used as `beforeHandle` in `.guard()` — Elysia automatically provides `cookie` in the context, so no changes needed to the guard call site. The function signature change in auth.ts is sufficient.

  **Must NOT do**:
  - Do NOT add any new dependencies
  - Do NOT change the JWT signing/verification logic
  - Do NOT modify `/auth/github` endpoint
  - Do NOT touch `/auth/verify` response shape (just change how it reads the token)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Straightforward modifications to 3 files, clear specifications, no architectural decisions
  - **Skills**: [`typescript-programmer`]
    - `typescript-programmer`: Elysia TypeScript API modifications
  - **Skills Evaluated but Omitted**:
    - `git-master`: Will commit at end, not needed during implementation
    - `frontend-ui-ux`: Backend-only task

  **Parallelization**:
  - **Can Run In Parallel**: NO (must complete before dashboard changes)
  - **Parallel Group**: Wave 1 (solo)
  - **Blocks**: Tasks 2, 3
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `apps/manager/src/shared/lib/auth.ts:28-65` — Current authGuard implementation (replace header reading with cookie reading)
  - `apps/manager/src/api/auth.routes.ts:65-73` — Existing cookie.sandbox_token.set() pattern in callback (reuse for logout)
  - `apps/manager/src/api/auth.routes.ts:91-115` — Current /auth/me header-based reading (replace with cookie)
  - `apps/manager/src/api/auth.routes.ts:116-134` — Current /auth/verify with header fallback (remove fallback)

  **API/Type References**:
  - `apps/manager/src/shared/lib/auth.ts:6-10` — AuthUser interface (unchanged)
  - `apps/manager/src/shared/lib/config.ts:46` — `config.dashboardUrl` for CORS origin

  **Infrastructure References**:
  - `apps/manager/src/index.ts:125` — Current `cors()` call (add credentials config)
  - `apps/manager/src/index.ts:199` — `.guard({ beforeHandle: authGuard })` call site (no change needed, Elysia provides cookie automatically)

  **External References**:
  - Elysia cookie docs: https://elysiajs.com/patterns/cookie — Reactive cookie API (`cookie.name.value`, `cookie.name.set()`)

  **Acceptance Criteria**:

  ```bash
  # No Authorization header reading in auth files
  grep -c "authorization\|Authorization\|Bearer" apps/manager/src/shared/lib/auth.ts apps/manager/src/api/auth.routes.ts
  # Assert: all counts are 0

  # login_token removed from callback
  grep -c "login_token" apps/manager/src/api/auth.routes.ts
  # Assert: 0

  # logout endpoint exists
  grep -c "logout" apps/manager/src/api/auth.routes.ts
  # Assert: >= 1

  # CORS has credentials
  grep "credentials" apps/manager/src/index.ts
  # Assert: matches

  # Typecheck
  bun run typecheck
  # Assert: exit 0
  ```

  **Commit**: YES
  - Message: `refactor(manager): switch auth to cookie-only, add logout endpoint, configure CORS credentials`
  - Files: `apps/manager/src/shared/lib/auth.ts`, `apps/manager/src/api/auth.routes.ts`, `apps/manager/src/index.ts`
  - Pre-commit: `bun run typecheck && bun run check`

---

- [ ] 2. Dashboard Client: Remove localStorage/header auth, add cookie credentials

  **What to do**:

  **2a. `apps/dashboard/src/api/client.ts`**:
  - **Remove** entirely: `getAuthToken`, `setAuthToken`, `clearAuthToken` functions
  - **Remove** entirely: `setSandboxCookie`, `clearSandboxCookie`, `getCookieDomain` functions
  - **Remove**: `AUTH_TOKEN_KEY` constant, `SANDBOX_COOKIE_NAME` constant
  - **Remove**: `COOKIE_DOMAIN` import from config
  - **Change** Eden Treaty config from header-based to credential-based:
    ```typescript
    export const api = treaty<ManagerApp>(API_HOST, {
      fetch: { credentials: "include" },
    });
    ```
  - **Add** `checkAuth` function:
    ```typescript
    export async function checkAuth() {
      const { data, error } = await api.auth.me.get();
      if (error) return null;
      return data;
    }
    ```
  - **Add** `logout` function:
    ```typescript
    export async function logout() {
      await api.auth.logout.post();
    }
    ```

  **2b. `apps/dashboard/src/config.ts`**:
  - Remove `COOKIE_DOMAIN` export

  **Must NOT do**:
  - Do NOT change API type exports at bottom of client.ts
  - Do NOT change `API_HOST` or `API_URL`

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Removing code and simple replacements, well-specified
  - **Skills**: [`typescript-programmer`]
    - `typescript-programmer`: TypeScript/Eden Treaty client modifications
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: No UI changes in this task

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential with Task 3)
  - **Blocks**: Task 3
  - **Blocked By**: Task 1

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/api/client.ts:1-81` — Entire current file (heavy modifications — remove lines 3, 7-52, replace 54-60)
  - `apps/dashboard/src/config.ts:14` — `COOKIE_DOMAIN` export to remove

  **API/Type References**:
  - `apps/dashboard/src/api/client.ts:62-81` — Type exports (keep unchanged)

  **External References**:
  - Eden Treaty fetch options: The `fetch` option in `treaty()` passes through to underlying fetch calls

  **WHY Each Reference Matters**:
  - `client.ts` is the ENTIRE file being restructured — executor needs full context
  - `config.ts` line 14 is the only line to remove
  - Type exports must be preserved exactly

  **Acceptance Criteria**:

  ```bash
  # No localStorage in dashboard
  grep -rc "localStorage" apps/dashboard/src/
  # Assert: 0

  # No document.cookie in dashboard
  grep -rc "document.cookie" apps/dashboard/src/
  # Assert: 0

  # No Authorization header in client
  grep -c "Authorization\|Bearer" apps/dashboard/src/api/client.ts
  # Assert: 0

  # credentials: include present
  grep "credentials" apps/dashboard/src/api/client.ts
  # Assert: matches "include"

  # COOKIE_DOMAIN removed from config
  grep -c "COOKIE_DOMAIN" apps/dashboard/src/config.ts
  # Assert: 0

  # Typecheck
  bun run typecheck
  # Assert: exit 0
  ```

  **Commit**: YES
  - Message: `refactor(dashboard): remove localStorage/header auth, use cookie credentials`
  - Files: `apps/dashboard/src/api/client.ts`, `apps/dashboard/src/config.ts`
  - Pre-commit: `bun run typecheck && bun run check`

---

- [ ] 3. Dashboard UI: Update login page and root layout for cookie auth

  **What to do**:

  **3a. `apps/dashboard/src/components/login-page.tsx`**:
  - Remove imports of `setAuthToken`, `setSandboxCookie` from `@/api/client`
  - Import `checkAuth` from `@/api/client`
  - Remove `login_token` handling from useEffect
  - Add on-mount auth check: call `checkAuth()` — if returns user, call `onLoginSuccess()`
  - Keep `login_error` handling (still needed for error display from callback redirect)
  - Keep `handleGitHubLogin` (still redirects to `/auth/github`)
  - Updated useEffect:
    ```typescript
    useEffect(() => {
      const params = new URLSearchParams(window.location.search);
      const loginError = params.get("login_error");

      if (loginError) {
        setError(getErrorMessage(loginError));
        window.history.replaceState({}, "", window.location.pathname);
        return;
      }

      // Check if already authenticated via cookie (e.g., after OAuth redirect)
      checkAuth().then((user) => {
        if (user) onLoginSuccess();
      });
    }, [onLoginSuccess]);
    ```

  **3b. `apps/dashboard/src/routes/__root.tsx`**:
  - Remove imports of `clearAuthToken`, `clearSandboxCookie` from `@/api/client`
  - Import `checkAuth`, `logout` from `@/api/client`
  - Change initial auth state from `localStorage.getItem` to `false` (will check on mount):
    ```typescript
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [isCheckingAuth, setIsCheckingAuth] = useState(true);
    ```
  - Add useEffect to check auth on mount:
    ```typescript
    useEffect(() => {
      checkAuth()
        .then((user) => { if (user) setIsAuthenticated(true); })
        .finally(() => setIsCheckingAuth(false));
    }, []);
    ```
  - Show loading state while checking:
    ```typescript
    if (isCheckingAuth) {
      return <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
    }
    ```
  - Update `handleLogout`:
    ```typescript
    const handleLogout = async () => {
      await logout();
      setIsAuthenticated(false);
    };
    ```
  - Import `Loader2` from lucide-react (add to existing import)
  - Import `useEffect` from react (add to existing import)

  **Must NOT do**:
  - Do NOT change sidebar navigation structure
  - Do NOT change any route definitions
  - Do NOT modify NavLink component

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Well-specified UI wiring changes, no design decisions
  - **Skills**: [`typescript-programmer`]
    - `typescript-programmer`: React + TypeScript modifications
  - **Skills Evaluated but Omitted**:
    - `frontend-ui-ux`: No visual/design changes, just auth wiring
    - `agent-browser`: No browser testing needed

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (after Task 2)
  - **Blocks**: None
  - **Blocked By**: Task 2

  **References**:

  **Pattern References**:
  - `apps/dashboard/src/components/login-page.tsx:16-33` — Current useEffect with login_token handling (replace entirely)
  - `apps/dashboard/src/routes/__root.tsx:49-63` — Current auth state + logout logic (replace)
  - `apps/dashboard/src/routes/__root.tsx:22` — Current import of `clearAuthToken, clearSandboxCookie` (replace with `checkAuth, logout`)

  **API/Type References**:
  - `apps/dashboard/src/api/client.ts` — New `checkAuth()` and `logout()` functions (from Task 2)

  **WHY Each Reference Matters**:
  - `login-page.tsx:16-33` is the exact block to rewrite (useEffect)
  - `__root.tsx:49-63` contains all auth state management to replace
  - Import line 22 needs updating to use new function names

  **Acceptance Criteria**:

  ```bash
  # No login_token references in dashboard
  grep -rc "login_token" apps/dashboard/src/
  # Assert: 0

  # No localStorage in dashboard
  grep -rc "localStorage" apps/dashboard/src/
  # Assert: 0

  # No clearAuthToken/setAuthToken/clearSandboxCookie/setSandboxCookie
  grep -rc "clearAuthToken\|setAuthToken\|clearSandboxCookie\|setSandboxCookie" apps/dashboard/src/
  # Assert: 0

  # checkAuth is used
  grep -c "checkAuth" apps/dashboard/src/components/login-page.tsx apps/dashboard/src/routes/__root.tsx
  # Assert: both files have matches

  # logout is used
  grep -c "logout" apps/dashboard/src/routes/__root.tsx
  # Assert: >= 1

  # Full typecheck
  bun run typecheck
  # Assert: exit 0

  # Lint
  bun run check
  # Assert: exit 0
  ```

  **Commit**: YES
  - Message: `refactor(dashboard): update UI for cookie-based auth flow`
  - Files: `apps/dashboard/src/components/login-page.tsx`, `apps/dashboard/src/routes/__root.tsx`
  - Pre-commit: `bun run typecheck && bun run check`

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1 | `refactor(manager): switch auth to cookie-only, add logout endpoint, configure CORS credentials` | auth.ts, auth.routes.ts, index.ts | `bun run typecheck && bun run check` |
| 2 | `refactor(dashboard): remove localStorage/header auth, use cookie credentials` | client.ts, config.ts | `bun run typecheck && bun run check` |
| 3 | `refactor(dashboard): update UI for cookie-based auth flow` | login-page.tsx, __root.tsx | `bun run typecheck && bun run check` |

---

## Success Criteria

### Verification Commands
```bash
# Zero header auth in auth code
grep -r "Authorization\|Bearer" apps/manager/src/shared/lib/auth.ts apps/manager/src/api/auth.routes.ts  # Expected: no matches

# Zero localStorage in dashboard
grep -r "localStorage" apps/dashboard/src/  # Expected: no matches

# Zero client-side cookie manipulation
grep -r "document.cookie" apps/dashboard/src/  # Expected: no matches

# Zero login_token references
grep -r "login_token" apps/manager/src/ apps/dashboard/src/  # Expected: no matches

# CORS has credentials
grep "credentials" apps/manager/src/index.ts  # Expected: credentials: true

# Typecheck + lint
bun run typecheck  # Expected: exit 0
bun run check      # Expected: exit 0
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] `bun run typecheck` passes
- [ ] `bun run check` passes
