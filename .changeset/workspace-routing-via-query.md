---
"@konfeature/opencode-atelier": minor
---

Bump `@opencode-ai/sdk` and `@opencode-ai/plugin` peer ranges to `^1.15.0`. In v1.15.0 the legacy hono backend is removed and the effect-httpapi server is the only backend, giving slightly better perf and a unified middleware stack.

Drop the manager-minted symlink (`<sourceLocalDirectory>` → workspace dir) and the `sourceLocalDirectory` field from `AtelierExtra` / `POST /sandboxes` body. The adapter's `target()` now bakes `?workspace=<id>` into the proxy URL so the local opencode's `WorkspaceRoutingMiddleware` resolves through the adapter on the control-plane side.

⚠️ **Known limitation — TUI warp:** warping a local OpenCode TUI into an Atelier sandbox lands on a phantom instance (blank session, missing replies). This is an upstream issue in the OpenCode TUI client (`packages/opencode/src/cli/cmd/tui/thread.ts:240`), which configures the SDK with `directory = process.cwd()` (the user's local Mac path) and auto-injects `?directory=<local cwd>` into every GET. The proxy preserves the query string and the remote's `WorkspaceRoutingMiddleware.defaultDirectory()` picks up the bogus path. See `packages/opencode-atelier/README.md#known-limitations`. **Dashboard, SSH, and VSCode-Remote are all unaffected** — use those for remote sandbox interactions until upstream addresses the TUI client.
