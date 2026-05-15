---
"@konfeature/opencode-atelier": minor
---

Route warp traffic via `?workspace=<id>` instead of relying on a manager-minted symlink at `<sourceLocalDirectory>` → workspace dir. The adapter's `target()` now bakes the OpenCode workspace id into the proxy URL so the local opencode's `WorkspaceRoutingMiddleware` resolves through the adapter before falling back to directory-based routing. The `sourceLocalDirectory` field is removed from `AtelierExtra` and from the `POST /sandboxes` body — restarts no longer need it. Bumps `@opencode-ai/sdk` and `@opencode-ai/plugin` peer ranges to `^1.15.0`.
