# @konfeature/opencode-atelier

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
