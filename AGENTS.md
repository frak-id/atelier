# Atelier

K8s (Kata Containers) orchestrator for isolated dev environments. Bun monorepo + Rust agent.

## Structure

```
apps/
├── server/       # Bun/Elysia server — runtime/control/sessions/api (see apps/server/AGENTS.md)
├── console/      # React 19 SPA (TanStack Router) — the web GUI
├── cli/          # @atelier/cli — host CLI (compiled Bun binary)
└── agent-v2/     # In-pod agent (`atelier-agent`, Rust, static musl scratch image)
packages/
├── shared/       # TypeBox schemas, config loaders (cross-app)
├── spec/         # @atelier/spec — the SandboxSpec seam contract
└── compose/      # @atelier/compose — client-side harness/preset/spec-merge SDK
charts/atelier/   # Helm chart (shared cluster infra: zot + cliproxy + sshpiper + certs)
infra/images/     # dev-base + dev-cloud Dockerfiles (built via BuildKit in-cluster)
infra/k8s/v2/     # Server + console app manifests (see infra/k8s/v2/README.md)
scripts/          # deploy-k8s.sh (SSH→k3s, infra chart), bump-version.ts
```

## Where To Look

| Task | Location |
|------|----------|
| Add API route | `apps/server/src/api/` (import from `container.ts`) |
| Runtime/control/sessions | `apps/server/src/` (see `apps/server/AGENTS.md`) |
| K8s/agent integration | `apps/server/src/runtime/` |
| Sandbox internals | `apps/agent-v2/src/` (Rust, no Bun/Node) |
| Console UI | `apps/console/src/components/` + `routes/` |
| Cross-app config | `packages/shared/src/` |
| Shared cluster infra | `charts/atelier/templates/` |
| App deploy manifests | `infra/k8s/v2/` |
| SandboxSpec contract | `packages/spec/src/` |
| Harness/preset composition | `packages/compose/src/` |
| Host CLI | `apps/cli/src/` |

## Commands

```bash
bun install                          # Install dependencies
bun run --filter @atelier/server dev # Dev server (mock mode, port 4000)
bun run check                        # Biome lint + format
bun run typecheck                    # tsc --noEmit (per-workspace via --filter)
```

## Dependency versions

Versions shared by two or more workspaces live in the **Bun catalog** in the root
`package.json` (`workspaces.catalog`). Those workspaces declare the dependency as
`"catalog:"` instead of a literal range, so a version is bumped in exactly one place
and workspaces cannot silently drift apart.

Currently catalogued: `@elysiajs/eden`, `@sinclair/typebox`, `@types/bun`, `typescript`.

When a dependency becomes used by a second workspace, move it into the catalog and
replace both ranges with `"catalog:"`. Single-workspace dependencies keep a normal range.

## Critical Constraints

| Constraint | Rule | Why |
|------------|------|-----|
| **sandbox-agent** | Rust runtime, NO Bun/Node APIs | Lightweight, no AVX dependency |
| **K8s Ingress** | Per-tool Ingress created via KubeClient | Host-based routing for sandbox tools |
| **CLI** | MUST run as root | System-level operations |

## Runtimes

| Component | Runtime | Why |
|-----------|---------|-----|
| Server API | **Bun** | Performance, native Elysia |
| Console | **Vite/Browser** | React SPA, static deploy |
| Sandbox Agent | **Rust** | Lightweight, static musl binary |
| CLI | **Bun** (compiled) | Native binary for host server |

## Conventions

- **Biome**: 80-char lines, double quotes, always semicolons, 2-space indent
- **TypeScript**: Strict mode, `noUncheckedIndexedAccess`, bundler resolution
- **Logging**: `createChildLogger("name")` — always use child logger with context
- **Errors**: Custom hierarchy — `NotFoundError`, `ValidationError`, `ResourceExhaustedError`
- **DI**: Manual wiring in `apps/server/src/api/container.ts`, routes import from container only
- **Mock mode**: `ATELIER_SERVER_MODE=mock bun run dev` — no K8s needed locally
- **No tests**: No test framework configured

See each app's AGENTS.md for component-specific guidelines.

For code patterns and DI details, see [docs/patterns.md](docs/patterns.md).
For critical gotchas, see [docs/constraints.md](docs/constraints.md).
For network, domains, and cleanup, see [docs/infrastructure.md](docs/infrastructure.md).
For full architecture, see [docs/architecture.md](docs/architecture.md).
