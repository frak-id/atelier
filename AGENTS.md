# FRAK SANDBOX

Firecracker microVM orchestrator for isolated dev environments. Bun monorepo.

## Commands

```bash
bun install          # Install dependencies
bun run dev          # Dev server (apps/manager)
bun run check        # Biome lint + format
bun run typecheck    # tsc --build
```

## Critical: Bun vs Node.js

**sandbox-agent MUST target Node.js** (Bun crashes in Firecracker - SIGILL/AVX):

```bash
bun build --bundle --target=node --outfile=dist/agent.mjs src/index.ts
```

## Further Reading

- [Constraints](docs/constraints.md) - Critical gotchas that break things
- [Patterns](docs/patterns.md) - Service patterns, DI, error handling
- [Infrastructure](docs/infrastructure.md) - Network, domains, VM communication
- [Design Spec](docs/design-spec.md) - Full architecture specification
