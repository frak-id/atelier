# Atelier

K8s (Kata Containers) orchestrator for isolated dev environments. Bun monorepo + Rust agent.

## Structure

```
apps/
├── manager/      # v1 Bun/Elysia API + DI container (feature-frozen, parallel track)
├── server/       # v2 Bun/Elysia server — runtime/control/sessions/api (see apps/server/AGENTS.md)
├── dashboard/    # React 19 SPA (TanStack Router + Eden Treaty)
└── agent-rust/   # In-pod HTTP agent (Hyper, ~2MB musl static)
packages/
├── shared/                     # TypeBox schemas, config loaders (cross-app)
├── spec/                       # @atelier/spec — the v2 SandboxSpec seam contract
├── compose/                    # @atelier/compose — client-side harness/preset/spec-merge SDK
└── opencode-atelier/           # OpenCode plugin (npm-published)
charts/atelier/   # Helm chart (K8s deploy: manager + dashboard + zot)
infra/images/     # dev-base + dev-cloud Dockerfiles (built via Kaniko in-cluster)
scripts/          # deploy-k8s.sh (SSH→k3s), bump-version.ts
```

## Where To Look

| Task | Location |
|------|----------|
| Add API route | `apps/manager/src/api/` (import from `container.ts`) |
| Add module/service | `apps/manager/src/modules/` (wire in `container.ts`) |
| Multi-step workflow | `apps/manager/src/orchestrators/` (with rollback) |
| K8s/agent integration | `apps/manager/src/infrastructure/` |
| Sandbox internals | `apps/agent-rust/src/` (Rust, no Bun/Node) |
| Dashboard UI | `apps/dashboard/src/components/` + `routes/` |
| Cross-app config | `packages/shared/src/` |
| K8s deploy | `charts/atelier/templates/` |
| Plugin (npm) | `packages/opencode-atelier/` |
| v2 runtime/control/sessions/api | `apps/server/src/` (see `apps/server/AGENTS.md`) |
| v2 SandboxSpec contract | `packages/spec/src/` |
| v2 harness/preset composition | `packages/compose/src/` |

## Commands

```bash
bun install          # Install dependencies
bun run dev          # Dev server (apps/manager, port 4000)
bun run check        # Biome lint + format
bun run typecheck    # tsgo --noEmit (per-workspace via --filter)
bun run deploy       # Build + SSH deploy to production
```

## Critical Constraints

| Constraint | Rule | Why |
|------------|------|-----|
| **sandbox-agent** | Rust runtime, NO Bun/Node APIs | Lightweight, no AVX dependency |
| **K8s Ingress** | Per-tool Ingress created via KubeClient | Host-based routing for sandbox tools |
| **CLI** | MUST run as root | System-level operations |

## Runtimes

| Component | Runtime | Why |
|-----------|---------|-----|
| Manager API | **Bun** | Performance, native Elysia |
| Dashboard | **Vite/Browser** | React SPA, static deploy |
| Sandbox Agent | **Rust** | Lightweight, TCP transport |
| CLI | **Bun** (compiled) | Native binary for host server |

## Conventions

- **Biome**: 80-char lines, double quotes, always semicolons, 2-space indent
- **TypeScript**: Strict mode, `noUncheckedIndexedAccess`, bundler resolution
- **Logging**: `createChildLogger("name")` — always use child logger with context
- **Errors**: Custom hierarchy — `NotFoundError`, `ValidationError`, `ResourceExhaustedError`
- **DI**: Manual wiring in `container.ts`, routes import from container only
- **Mock mode**: `ATELIER_SERVER_MODE=mock bun run dev` — no K8s needed locally
- **No tests**: No test framework configured

See each app's AGENTS.md for component-specific guidelines.

For code patterns and DI details, see [docs/patterns.md](docs/patterns.md).
For critical gotchas, see [docs/constraints.md](docs/constraints.md).
For network, domains, and cleanup, see [docs/infrastructure.md](docs/infrastructure.md).
For full architecture, see [docs/architecture.md](docs/architecture.md).
