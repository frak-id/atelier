# @konfeature/opencode-atelier

OpenCode plugin (npm-published) connecting OpenCode to Atelier sandboxes.

## Build

```bash
bun run build       # build.ts → dist/index.js
bun run dev         # watch mode
```

Bundled with `bun build` — single ESM file, peer deps externalized (`@opencode-ai/plugin`, `@opencode-ai/sdk`, `zod`).

## Structure

| File | Purpose |
|------|---------|
| `src/index.ts` | Plugin entry — registers adaptor + commands + system prompt |
| `src/adaptor.ts` | Atelier workspace adaptor (task dispatch, status checks) |
| `src/client.ts` | Eden Treaty client to Manager API |
| `src/commands.ts` | `/atelier:*` slash commands |
| `src/config.ts` | Load `atelier.config.json` / `.atelier.json` / env |
| `src/workspace-resolver.ts` | Auto-resolve workspace from git remote |
| `src/system-prompt.ts` | Inject Atelier context into OpenCode prompts |

## Conventions

- **Type-safe API**: imports `App` type from `@frak/atelier-manager` for Eden Treaty
- **Config sources**: `atelier.config.json` > `.atelier.json` > env (`ATELIER_MANAGER_URL`, `ATELIER_API_KEY`)
- **No deps on Manager runtime**: Manager is `devDependencies` for types only
- **Public package**: `publishConfig.access: public`, MIT license — careful with breaking changes

## Anti-Patterns

- **DO NOT** import from `@frak/atelier-manager` at runtime — types only
- **DO NOT** add Bun-specific APIs — must run in any Node-compatible OpenCode host
- **DO NOT** bundle peer deps (`@opencode-ai/*`, `zod`) — externalized in `build.ts`
