# @konfeature/opencode-atelier

OpenCode plugin that connects [OpenCode](https://github.com/anomalyco/opencode) to an [Atelier](https://github.com/frak-id/atelier) instance, letting you dispatch coding tasks to isolated Kata Containers sandboxes from your local OpenCode session.

## What it does

- Registers an `atelier` workspace adaptor with OpenCode so tasks can be created against remote Atelier sandboxes.
- Auto-resolves the active Atelier workspace from the current git context.
- Injects `/atelier:*` slash commands into OpenCode (task dispatch, status checks, etc.).
- Adds Atelier-specific context to the system prompt when relevant.

## Install

```bash
# bun
bun add -d @konfeature/opencode-atelier

# npm
npm install --save-dev @konfeature/opencode-atelier
```

## Usage

Add the plugin to your OpenCode config (`opencode.json`):

```json
{
  "plugin": ["@konfeature/opencode-atelier"]
}
```

Then create an `atelier.config.json` (or `.atelier.json`) in your project root, or set the manager URL through environment variables:

```json
{
  "managerUrl": "https://sandbox.example.com",
  "apiKey": "...",
  "workspaceId": "optional-explicit-workspace-id"
}
```

The plugin will auto-resolve a workspace from the active git remote when `workspaceId` is omitted.

## Remote TUI warp

Warping a TUI session into an Atelier sandbox (`/warp`) works on OpenCode **1.16.2+**. Warp routes sessions through the event-sourced workspace sync protocol (`/sync/replay` + `/sync/steal`) rather than proxying every request by directory: the remote resolves its own project and working directory from the sandbox's `process.cwd()` (where the manager launched `opencode serve`), and since 1.16.2 the `project_id` is derived from the git remote URL — so the local CLI and the sandbox compute the same id automatically even though their filesystem paths differ.

Requirements:

- Both the local OpenCode CLI **and** the sandbox binary must be **≥ 1.16.2** (pinned via `sharedBinaries.opencode.version` in the Helm values).
- The plugin forwards `OPENCODE_EXPERIMENTAL_WORKSPACES=true` and `OPENCODE_WORKSPACE_ID` so the remote boots in workspace mode.

The dashboard (browser), SSH, and VSCode/JetBrains Remote also work, since they don't depend on directory-based request routing.

## Requirements

This plugin expects:

- A running Atelier manager reachable at `managerUrl`.
- Peer dependencies provided by your OpenCode installation: `@opencode-ai/plugin`, `@opencode-ai/sdk`, `zod`.

## License

[MIT](./LICENSE.md) — © KONFeature
