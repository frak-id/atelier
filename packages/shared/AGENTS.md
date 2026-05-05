# @frak/atelier-shared

Cross-app TypeBox schemas, config loaders, and constants. Consumed by Manager, Dashboard, and the OpenCode plugin via subpath exports.

## Exports

| Subpath | Purpose |
|---------|---------|
| `.` | Constants + `validateConfig()` |
| `./constants` | Shared constants (domains, ports, defaults) |
| `./config` | `AtelierConfig` schema (TypeBox) |
| `./config-loader` | Multi-source config loader (env + file + defaults) |
| `./sandbox-config` | Per-sandbox config schema |
| `./sandbox-config-loader` | Sandbox config loader |

## Schema Generation

```bash
bun run generate-schema   # scripts/generate-schema.ts → schemas/sandbox.config.full-example.json
```

Run after editing schemas. Generated JSON is referenced from `docs/infrastructure.md`.

## Conventions

- **TypeBox over Zod**: required because Elysia validates with TypeBox natively
- **Subpath exports only**: never import via `@frak/atelier-shared/src/...` — use the declared exports
- **Loaders are pure**: no side effects, no logging — return validated config objects
- **Config priority**: env vars > config file > schema defaults

## Anti-Patterns

- **DO NOT** add runtime dependencies beyond `@sinclair/typebox` — keep this package light
- **DO NOT** export internal helpers without adding a subpath export entry
