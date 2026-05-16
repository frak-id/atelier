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

## Known limitations

### TUI warp shows a blank session (phantom-instance bug)

Warping a TUI session into an Atelier sandbox lands the TUI on an empty instance — sessions are missing, replies don't appear. The dashboard (browser) is unaffected.

**Root cause is upstream, in the OpenCode TUI client — not in Atelier:**

1. The TUI configures `@opencode-ai/sdk` with `directory = process.cwd()` (the user's local Mac path, e.g. `/Users/alice/Workspace/Frak/wallet`) — see `packages/opencode/src/cli/cmd/tui/thread.ts:140,240`.
2. The SDK's request interceptor (`packages/sdk/js/src/v2/client.ts:17-45`) auto-injects `?directory=<local cwd>` into every GET/HEAD request.
3. After warp, the local opencode proxies these requests to the remote sandbox. The proxy strips `?workspace` but **preserves `?directory`** (`packages/opencode/src/server/shared/workspace-routing.ts:29-36`).
4. The remote opencode's `WorkspaceRoutingMiddleware` falls back to `defaultDirectory(request, url)` which reads `?directory` from the URL first — returning the user's local Mac path, which doesn't exist on the VM.
5. `Project.fromDirectory` walks up from the bogus path, finds no `.git`, returns `ProjectID.global`. `InstanceStore` caches a phantom instance keyed by the local path — disconnected from the real workspace at `/home/dev/workspace/<repo>`.

**Why the dashboard works:** the browser SDK is constructed in `apps/dashboard/src/api/opencode.ts` with no `directory` config, so no `?directory=` is injected. The remote opencode then falls back to `process.cwd()`, which is the actual workspace dir (`opencode serve` is launched with `cd <workspaceDir>`).

**Possible upstream fixes** (not implemented here):

- Server-side (~5 lines): in `workspace-routing.ts:165`, short-circuit `defaultDirectory` to `process.cwd()` when `Flag.OPENCODE_WORKSPACE_ID` is set — the server is pinned to a workspace, so the client-supplied `?directory` is meaningless.
- Client-side: have `thread.ts` pass `directory: undefined` (not `cwd`) to `tui()` when the transport is external/remote (matching what `attach.ts` already does conditionally).

Until then: **use the dashboard for remote sandbox interactions**. SSH/VSCode-Remote/JetBrains-Remote also work fine since they bypass the OpenCode HTTP API entirely.

## Requirements

This plugin expects:

- A running Atelier manager reachable at `managerUrl`.
- Peer dependencies provided by your OpenCode installation: `@opencode-ai/plugin`, `@opencode-ai/sdk`, `zod`.

## License

[MIT](./LICENSE.md) — © KONFeature
