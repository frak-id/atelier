# @konfeature/opencode-atelier

## 0.2.2

### Patch Changes

- 7cc3d2f: Retrigger release.

## 0.2.1

### Patch Changes

- bcd0e43: Fix blank TUI after `/warp` into an Atelier sandbox.

  After the FK fix landed in 0.1.6, `/sync/replay` succeeds but the TUI still
  shows a blank screen because the warped `session.directory` row carries the
  local Mac path (e.g. `/Users/quentin/Workspace/...`). The remote OpenCode
  `InstanceMiddleware` (hono backend) reads `?directory=` from the request
  with no fallback to `workspace.directory`, so the TUI's first `GET /path`
  bootstraps a phantom instance for a non-existent path on the sandbox.

  The plugin's `target()` now returns an `x-opencode-directory` header pointing
  at the resolved workspace directory. The local `@opencode-ai/sdk` request
  interceptor (`packages/sdk/js/src/client.ts:rewrite`) reads that header and
  injects `?directory=<workspace dir>` on every GET/HEAD request to the remote.
  The middleware lands on the right instance, the TUI renders correctly.

  Caveat: the SDK only injects when the URL doesn't already have
  `?directory=`. If a caller passes `query.directory` explicitly, our header
  is bypassed. The current TUI relies on the interceptor for most routes, so
  this is sufficient for the warp scenario today.

  Long term, the proper fix is to switch the sandbox's OpenCode to the new
  effect-httpapi backend (`OPENCODE_EXPERIMENTAL_HTTPAPI=true`) whose
  `WorkspaceRoutingMiddleware` resolves directory from the chain
  `sessionID → workspace_id → workspace.directory`, which sidesteps the
  header trick entirely. The migration recipe is documented in
  `adaptor.ts:target()`.

## 0.2.0

### Minor Changes

- b9d8b13: Stop forwarding `OPENCODE_AUTH_CONTENT` from the local CLI into the
  Atelier sandbox.

  The whole point of warping into an Atelier sandbox is to reuse the
  sandbox's own opencode credentials (provisioned via the manager's
  auth-sync + cliproxy). Forwarding `OPENCODE_AUTH_CONTENT` would also
  leak the user's local provider tokens into the pod env (visible via
  `kubectl describe pod`, in-sandbox `ps`, and any structured manager log
  that captures the env block). Removing it from `FORWARDED_ENV_KEYS`
  makes auth strictly server-side.

  The remaining whitelist is now:

  - `OPENCODE_EXPERIMENTAL_WORKSPACES`
  - `OPENCODE_WORKSPACE_ID`
  - `OTEL_EXPORTER_OTLP_HEADERS`
  - `OTEL_EXPORTER_OTLP_ENDPOINT`
  - `OTEL_RESOURCE_ATTRIBUTES`

  If you previously relied on local auth being forwarded automatically,
  configure provider credentials directly on the sandbox (via Atelier's
  shared-auth sync or a per-workspace `opencode auth` invocation) before
  warping.

## 0.1.5

### Patch Changes

- 5aeab84: Fix `FOREIGN KEY constraint failed` when warping a session into a freshly
  spawned Atelier sandbox.

  `adaptor.configure()` previously hardcoded `directory: "/home/dev/workspace"`
  for every workspace, but the remote sandbox actually boots OpenCode from
  `/home/dev/workspace/<clonePath>` for single-repo workspaces. OpenCode
  hashes the directory to derive `project_id`, so the local CLI was sending
  `/sync/replay` events tagged with one project_id while the remote DB only
  knew the project hashed from the actual sandbox path. The first replay
  batch failed its FK on `message.session_id` / `session.project_id` and
  the warp aborted.

  The plugin now fetches the workspace from the manager during `configure()`
  and resolves the directory using the **exact same expression** as
  `apps/manager/src/orchestrators/sandbox-config.ts` so the two paths agree
  byte-for-byte (handles both `/workspace/wallet` and `/wallet` clone-path
  shapes without ever doubling the `/workspace` segment):

  ```
  const suffix = clonePath.startsWith("/workspace")
    ? clonePath
    : `/workspace${clonePath}`;
  return `${VM_HOME}${suffix}`;
  ```

  Multi-repo workspaces still use the parent `/home/dev/workspace`. Lookup
  failure falls back to the same parent path so the plugin remains usable
  if the manager is briefly unreachable.

## 0.1.4

### Patch Changes

- 654bdb5: Fix `FOREIGN KEY constraint failed` when warping a session into a freshly
  spawned Atelier sandbox.

  `adaptor.configure()` previously hardcoded `directory: "/home/dev/workspace"`
  for every workspace, but the remote sandbox actually boots OpenCode from
  `/home/dev/workspace/<clonePath>` for single-repo workspaces. OpenCode
  hashes the directory to derive `project_id`, so the local CLI was sending
  `/sync/replay` events tagged with one project_id while the remote DB only
  knew the project hashed from the deeper path. The first replay batch
  failed its FK on `message.session_id` / `session.project_id` and the
  warp aborted.

  The plugin now fetches the workspace from the manager during `configure()`
  and resolves the directory using the same logic as
  `apps/manager/src/orchestrators/sandbox-config.ts`:

  - 1 repo → `/home/dev/workspace/<clonePath>`
  - else → `/home/dev/workspace`

  Best-effort: if the workspace lookup fails, the plugin falls back to the
  old behaviour (`/home/dev/workspace`), which still works for multi-repo
  workspaces.

## 0.1.3

### Patch Changes

- e60dc41: Spawn sandboxes directly instead of going through Atelier tasks.

  The plugin no longer creates an Atelier task per opencode workspace. Each
  opencode workspace now maps 1:1 to a sandbox spawned via `POST /sandboxes`,
  tagged with `origin: { source: "opencode-plugin", externalId: <workspaceId> }`.
  Recovery on restart goes through `GET /sandboxes?originSource=opencode-plugin&originExternalId=<workspaceId>`
  instead of looking up a task.

  User-visible changes:

  - `AtelierExtra` shrunk to `{ managerUrl, atelierWorkspaceId, branch? }`.
    The previously persisted runtime fields (`taskId`, `sandboxId`,
    `sandboxOpencodeUrl`, `opencodePassword`, `description`, `baseBranch`)
    are gone — runtime state lives in the in-memory cache and is recovered
    via the origin filter.
  - `Task` is no longer re-exported from the package.
  - Slash commands: `/atelier-tasks` removed. `/atelier-status` now takes a
    sandbox id (was task id). `/atelier-sandboxes` replaces task listing.

  Requires manager `>=` the version exposing `Sandbox.origin` plus the
  `originSource` / `originExternalId` filters on `GET /sandboxes`.

## 0.1.2

### Patch Changes

- a2ba0b9: Tag tasks created via the plugin with `integration: { source: "opencode-plugin", threadKey: <workspaceId> }` so they are identifiable on the Atelier dashboard. Requires manager `>=` the version exposing `integration` on `POST /api/tasks`.

## 0.1.1

### Patch Changes

- a982d0a: Test the changesets + trusted-publishing release flow.
