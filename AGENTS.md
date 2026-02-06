# L'atelier

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
| **sandbox-agent** | Rust runtime, NO Bun/Node APIs | Bun crashes in Firecracker (SIGILL/AVX) |
| **LVM snapshots** | ALWAYS use `-kn` flag | Without it, volume invisible to FC |
| **Caddy routes** | Wildcard MUST be last | CaddyService auto-manages ordering |
| **CLI** | MUST run as root | System-level operations |
| **Cleanup order** | Kill PID → socket → LVM → TAP → IP → Caddy | Resources leak if wrong order |

## Runtimes

| Component | Runtime | Why |
|-----------|---------|-----|
| Manager API | **Bun** | Performance, native Elysia |
| Dashboard | **Vite/Browser** | React SPA, static deploy |
| Sandbox Agent | **Rust** | Lightweight, vsock support, no AVX |
| Agent (Rust) | **Tokio** | Alternative implementation |
| CLI | **Bun** (compiled) | Native binary for host server |

## Conventions

- **Biome**: 80-char lines, double quotes, always semicolons, 2-space indent
- **TypeScript**: Strict mode, `noUncheckedIndexedAccess`, bundler resolution
- **Logging**: `createChildLogger("name")` — always use child logger with context
- **Errors**: Custom hierarchy — `NotFoundError`, `ValidationError`, `ResourceExhaustedError`
- **DI**: Manual wiring in `container.ts`, routes import from container only
- **Mock mode**: `ATELIER_SERVER_MODE=mock bun run dev` — no KVM/LVM needed locally
- **No tests**: No test framework configured

See each app's AGENTS.md for component-specific guidelines.

For code patterns and DI details, see [docs/patterns.md](docs/patterns.md).
For critical gotchas, see [docs/constraints.md](docs/constraints.md).
For network, domains, and cleanup, see [docs/infrastructure.md](docs/infrastructure.md).
For full architecture, see [docs/architecture.md](docs/architecture.md).
