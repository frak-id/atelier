# @konfeature/opencode-atelier

## 0.1.2

### Patch Changes

- a2ba0b9: Tag tasks created via the plugin with `integration: { source: "opencode-plugin", threadKey: <workspaceId> }` so they are identifiable on the Atelier dashboard. Requires manager `>=` the version exposing `integration` on `POST /api/tasks`.

## 0.1.1

### Patch Changes

- a982d0a: Test the changesets + trusted-publishing release flow.
