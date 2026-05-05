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
