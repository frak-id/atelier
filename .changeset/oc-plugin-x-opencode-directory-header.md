---
"@konfeature/opencode-atelier": patch
---

Fix blank TUI after `/warp` into an Atelier sandbox.

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
