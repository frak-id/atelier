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

## Requirements

This plugin expects:

- A running Atelier manager reachable at `managerUrl`.
- Peer dependencies provided by your OpenCode installation: `@opencode-ai/plugin`, `@opencode-ai/sdk`, `zod`.

## License

[MIT](./LICENSE.md) — © KONFeature
