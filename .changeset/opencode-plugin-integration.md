---
"@konfeature/opencode-atelier": patch
---

Tag tasks created via the plugin with `integration: { source: "opencode-plugin", threadKey: <workspaceId> }` so they are identifiable on the Atelier dashboard. Requires manager `>=` the version exposing `integration` on `POST /api/tasks`.
