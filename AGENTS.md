# FRAK SANDBOX

Firecracker microVM orchestrator for isolated dev environments. Bun monorepo.

## Commands

```bash
bun install          # Install dependencies
bun run dev          # Dev server (apps/manager, port 4000)
bun run check        # Biome lint + format
bun run typecheck    # tsc --build
bun run deploy       # Build + SSH deploy to production
```

## Critical Constraints

| Constraint | Rule | Why |
|------------|------|-----|
| **sandbox-agent** | MUST target Node.js | Bun crashes in Firecracker (SIGILL/AVX) |
| **LVM snapshots** | ALWAYS use `-kn` flag | Without it, volume invisible to FC |
| **Caddy routes** | Wildcard MUST be last | CaddyService auto-manages ordering |
| **CLI** | MUST run as root | System-level operations |
| **Cleanup order** | Kill PID → socket → LVM → TAP → IP → Caddy | Resources leak if wrong order |

```bash
# Agent build - MUST use --target=node
bun build --bundle --target=node --outfile=dist/agent.mjs src/index.ts
```

## Structure

```
oc-sandbox/
├── apps/
│   ├── manager/           # Elysia API (Bun, port 4000)
│   └── dashboard/         # React + Vite (TanStack Router/Query)
├── packages/
│   ├── shared/            # Constants, types (PATHS, NETWORK, LVM)
│   └── sandbox-agent/     # In-VM agent (Node.js only, port 9999)
├── infra/
│   ├── cli/               # Provisioning CLI (compiles to Linux binary)
│   ├── images/            # Dockerfiles + build scripts
│   ├── caddy/             # Reverse proxy config
│   └── systemd/           # Service files
└── docs/                  # Architecture docs
```

## Component Guides

- **[Manager API](apps/manager/AGENTS.md)** - Backend orchestration (Elysia, Bun)
- **[Dashboard](apps/dashboard/AGENTS.md)** - React web interface (TanStack Router/Query)
- **[CLI](infra/cli/AGENTS.md)** - Server provisioning (runs as root)
- **[Sandbox Agent](packages/sandbox-agent/AGENTS.md)** - In-VM agent (Node.js only)

## Deep Dives

- [Constraints](docs/constraints.md) - Critical gotchas
- [Patterns](docs/patterns.md) - Service patterns, DI, errors
- [Infrastructure](docs/infrastructure.md) - Network, domains, cleanup
- [Design Spec](docs/design-spec.md) - Full architecture
