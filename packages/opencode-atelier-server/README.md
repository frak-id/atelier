# @frak/opencode-atelier-server

In-sandbox OpenCode plugin that pre-registers the local-machine `project_id`
into the sandbox's SQLite DB so cross-machine session warps don't FK-fail on
`session.project_id`.

See [`src/plugin.ts`](./src/plugin.ts) for the full rationale.

## How it ships

The plugin source (`src/plugin.ts`) is embedded as a string constant in
`src/plugin.embedded.ts` by `build.ts`. The atelier manager imports
`PLUGIN_SOURCE` from this package and writes it into each sandbox's
`~/.config/opencode/plugins/atelier-preregister.ts` at config-sync time.

The manager's `prebuild` script runs `bun --filter @frak/opencode-atelier-server build`,
so production bundles always pick up the latest `plugin.ts`. The embedded
file is committed for dev-mode `bun run` paths that skip the build step.

## Editing the plugin

```bash
# After editing src/plugin.ts
bun run build
# Commit both src/plugin.ts AND src/plugin.embedded.ts
```

## Maintenance

This plugin reaches into OpenCode's private SQLite schema. On opencode
upgrades, verify that `project.sql.ts` columns still match the set written
in `src/plugin.ts`. The plugin defensively bails on mismatch.
