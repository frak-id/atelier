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

## Component-Specific Guides

- **[CLI](infra/cli/AGENTS.md)** - Server provisioning CLI (runs as root on host)
- **[Manager](apps/manager/src/modules/AGENTS.md)** - Business logic modules (routes → service → repository)
- **[Infrastructure](apps/manager/src/infrastructure/AGENTS.md)** - Low-level services (Firecracker, Network, Storage, Caddy)
- **[Dashboard](apps/dashboard/AGENTS.md)** - React web interface (TanStack Router + Query)
- **[Sandbox Agent](packages/sandbox-agent/AGENTS.md)** - In-VM agent (Node.js only, port 9999)

## Further Reading

- [Constraints](docs/constraints.md) - Critical gotchas that break things
- [Patterns](docs/patterns.md) - Service patterns, DI, error handling
- [Infrastructure](docs/infrastructure.md) - Network, domains, VM communication
- [Design Spec](docs/design-spec.md) - Full architecture specification
