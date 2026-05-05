---
"@konfeature/opencode-atelier": patch
---

Fix `FOREIGN KEY constraint failed` when warping a session into a freshly
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

- 1 repo  → `/home/dev/workspace/<clonePath>`
- else    → `/home/dev/workspace`

Best-effort: if the workspace lookup fails, the plugin falls back to the
old behaviour (`/home/dev/workspace`), which still works for multi-repo
workspaces.
