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
| **sandbox-agent** | Deno runtime, NO Bun/Node APIs | Bun crashes in Firecracker (SIGILL/AVX) |
| **LVM snapshots** | ALWAYS use `-kn` flag | Without it, volume invisible to FC |
| **Caddy routes** | Wildcard MUST be last | CaddyService auto-manages ordering |
| **CLI** | MUST run as root | System-level operations |
| **Cleanup order** | Kill PID → socket → LVM → TAP → IP → Caddy | Resources leak if wrong order |

## Structure

```
oc-sandbox/
├── apps/
│   ├── manager/           # Elysia API (Bun, port 4000)
│   ├── dashboard/         # React + Vite (TanStack Router/Query)
│   ├── agent/             # In-VM agent (Deno, vsock + TCP :9999)
│   ├── agent-rust/        # Rust agent (alternative, Tokio + Hyper)
│   └── cli/               # Provisioning CLI (compiles to Linux binary)
├── packages/
│   └── shared/            # Constants, config schemas, config loaders
├── infra/
│   ├── images/            # Dockerfiles + build-image.sh (Docker → ext4)
│   ├── caddy/             # Caddyfile.template (reverse proxy)
│   └── systemd/           # Manager + network service files
├── scripts/
│   └── deploy.ts          # SSH deployment (build → tarball → SCP → restart)
└── docs/                  # Architecture docs
```

## Runtimes

| Component | Runtime | Why |
|-----------|---------|-----|
| Manager API | **Bun** | Performance, native Elysia |
| Dashboard | **Vite/Browser** | React SPA, static deploy |
| Sandbox Agent | **Deno** | Lightweight, vsock support, no AVX |
| Agent (Rust) | **Tokio** | Alternative implementation |
| CLI | **Bun** (compiled) | Native binary for host server |

## Where to Look

| Task | Location |
|------|----------|
| Add API endpoint | `apps/manager/src/api/{module}.routes.ts` |
| Add business logic | `apps/manager/src/modules/{module}/{module}.service.ts` |
| Add infrastructure | `apps/manager/src/infrastructure/{service}/` |
| Add complex workflow | `apps/manager/src/orchestrators/` |
| Wire dependencies | `apps/manager/src/container.ts` |
| Add dashboard route | `apps/dashboard/src/routes/{name}.tsx` |
| Add CLI command | `apps/cli/src/index.ts` (COMMANDS object) |
| Add agent endpoint | `apps/agent/src/routes/{name}.ts` |
| Add shared types | `packages/shared/src/` |
| Add base image tool | `infra/images/dev-base/Dockerfile` |

## Conventions

- **Biome**: 80-char lines, double quotes, always semicolons, 2-space indent
- **TypeScript**: Strict mode, `noUncheckedIndexedAccess`, bundler resolution
- **Logging**: `createChildLogger("name")` — always use child logger with context
- **Errors**: Custom hierarchy — `NotFoundError`, `ValidationError`, `ResourceExhaustedError`
- **DI**: Manual wiring in `container.ts`, routes import from container only
- **Mock mode**: `SANDBOX_MODE=mock bun run dev` — no KVM/LVM needed locally
- **No tests**: No test framework configured (testing is manual/external)

## Component Guides

- **[Manager API](apps/manager/AGENTS.md)** — Backend orchestration (Elysia, Bun)
- **[Dashboard](apps/dashboard/AGENTS.md)** — React web interface (TanStack Router/Query)
- **[CLI](apps/cli/AGENTS.md)** — Server provisioning (runs as root)
- **[Sandbox Agent](apps/agent/AGENTS.md)** — In-VM agent (Deno, vsock)

## Deep Dives

- [Constraints](docs/constraints.md) — Critical gotchas
- [Patterns](docs/patterns.md) — Service patterns, DI, errors
- [Infrastructure](docs/infrastructure.md) — Network, domains, cleanup
- [Design Spec](docs/design-spec.md) — Full architecture
