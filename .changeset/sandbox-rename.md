---
"@frak/atelier-manager": minor
"@frak/atelier-dashboard": minor
---

Add sandbox renaming.

The manager exposes `PATCH /sandboxes/:id` to set a sandbox's display name (trimmed server-side; an empty value clears the name and falls back to the id). The dashboard sandbox drawer gains an inline name editor (pencil → input → save/cancel) backed by a `useRenameSandbox` mutation that invalidates the sandbox list and detail queries on success.
