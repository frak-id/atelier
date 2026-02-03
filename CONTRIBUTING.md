# Contributing

Thanks for helping improve FRAK Sandbox.

## Quick start

```bash
bun install
SANDBOX_MODE=mock bun run dev
```

## Requirements

- Bun (project runtime)
- Rust toolchain (for `apps/agent-rust`)
- Docker (for image builds)

## Useful commands

```bash
bun run check       # Biome lint + format
bun run typecheck   # TypeScript typecheck
bun run dev         # Manager + dashboard in dev (see apps/AGENTS.md)
```

## Code style

- Biome: 80-char lines, double quotes, semicolons, 2-space indent
- Prefer existing patterns in `docs/patterns.md`
- Keep changes focused and minimal

## Pull requests

1. Open an issue first for large changes
2. Keep PRs small and scoped
3. Run `bun run check` and `bun run typecheck`
4. Update docs when behavior changes

## Security

Please do not open public issues for vulnerabilities.
See `SECURITY.md` for reporting instructions.
