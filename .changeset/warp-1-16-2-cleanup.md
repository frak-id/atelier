---
"@konfeature/opencode-atelier": minor
---

Require OpenCode `1.16.2+` and drop the TUI-warp workarounds it makes redundant.

Bump `@opencode-ai/sdk` and `@opencode-ai/plugin` peer ranges to `^1.16.2`. As of 1.16.2 warped sessions route through the event-sourced workspace sync protocol (`/sync/replay` + `/sync/steal`), and `project_id` is derived from the git remote URL — so the local CLI and the remote sandbox resolve the same project automatically even though their filesystem paths differ.

Removed (now handled upstream):

- `?workspace=<id>` injection in the adapter `target()` — the proxy/sync paths no longer rely on it.
- `resolveWorkspaceDirectory()` directory prediction and the `directory` announced from `configure()` — the remote resolves its own working dir from `process.cwd()`.
- `sourceProjectID` / `sourceWorkspaceID` capture + forwarding (and the matching `POST /sandboxes` fields) — the manager's `project_id` pre-register hack is no longer needed.
- Dead helpers: `resetClient`, `waitForSandboxReady`, and the `pollIntervalMs` / `pollTimeoutMs` config options.

✅ **TUI warp now works for remote Atelier sandboxes** (the previous phantom-instance limitation is resolved), provided both the local OpenCode CLI and the sandbox binary are `≥ 1.16.2`. The plugin still forwards `OPENCODE_EXPERIMENTAL_WORKSPACES` and `OPENCODE_WORKSPACE_ID` so the remote boots in workspace mode.
