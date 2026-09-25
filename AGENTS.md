# Atelier

Orchestrator for isolated dev environments: Kubernetes + Kata Containers in
production, a Docker backend for the single-user local mode. Bun monorepo +
Rust in-pod agent.

## Structure

```
apps/
├── server/       # @atelier/server — Bun/Elysia: runtime/control/sessions/api (see apps/server/AGENTS.md)
├── hub/          # @atelier/hub — company-knowledge hub: REST + MCP + push webhook over @atelier/knowledge
├── console/      # @atelier/console — React 19 SPA (Vite, TanStack Router), the web GUI
├── cli/          # @konfeature/atelier — host CLI (npm package, esbuild-bundled for Node)
└── agent-v2/     # In-pod agent (`atelier-agent`, Rust, static musl scratch image)
packages/
├── shared/       # @frak/atelier-shared — TypeBox schemas, constants, config loader
├── spec/         # @atelier/spec — the SandboxSpec seam contract
├── compose/      # @atelier/compose — client-side harness/preset/spec-merge SDK
└── knowledge/    # @atelier/knowledge — governed memory, temporal knowledge graph, hybrid search, code indexer (bun:sqlite)
integrations/     # Third-party systems on Atelier (open-inspect: sandbox provider patch + image seed context)
charts/atelier/   # Helm chart: shared cluster infra (zot, cliproxy, sshpiper, cert-manager issuers, kata runtimeclass, snapshot class)
infra/k8s/v2/     # Server + console app manifests (see infra/k8s/v2/README.md)
infra/nginx/      # Console nginx config (SPA + reverse proxy to the server)
scripts/          # deploy-k8s.sh (SSH → k3s: agent image + infra chart), bump-version.ts
Dockerfile        # Multi-target: `server` and `console` images
```

## Where To Look

| Task | Location |
|------|----------|
| Add API route | `apps/server/src/api/` (services come from `container.ts`) |
| Runtime/control/sessions | `apps/server/src/` (see `apps/server/AGENTS.md`) |
| K8s/Docker backends, agent integration | `apps/server/src/runtime/` |
| Sandbox internals | `apps/agent-v2/src/` (Rust, no Bun/Node) |
| Base images (dev-base/cloud/rust/browser) | `apps/server/src/runtime/registry/seeds/` (Dockerfile + rootfs, built by the server's image builder) |
| Console UI | `apps/console/src/components/` + `routes/` |
| Launchpad (non-tech surface) | `packages/spec/src/launchpad-spec.ts`, `apps/server/src/api/launchpad.{routes,lifecycle}.ts`, `apps/server/src/control/modules/launchpad/`, console `routes/launchpad.*` + `components/launchpad/` |
| Cross-app config | `packages/shared/src/` |
| Shared cluster infra | `charts/atelier/templates/` |
| App deploy manifests | `infra/k8s/v2/` |
| SandboxSpec contract | `packages/spec/src/` |
| Harness/preset composition | `packages/compose/src/` |
| Host CLI | `apps/cli/src/` |
| Company knowledge (memory, graph, code index) | `packages/knowledge/src/` (domain) + `apps/hub/src/` (REST/MCP/webhook); design in `docs/proposals/company-knowledge.md` |
| Open-Inspect integration | `integrations/open-inspect/` (seed: `apps/server/src/runtime/registry/seeds/open-inspect/`) |

## Commands

```bash
bun install                           # Install dependencies
bun run --filter @atelier/server dev  # Server in mock mode, port 4000
bun run --filter @atelier/console dev # Console on :5174, proxies API paths to :4000
bun run lint                          # Biome lint
bun run check                         # Biome lint + format, applies fixes (--write)
bun run typecheck                     # tsc --noEmit (TypeScript 7 native, per workspace)
bun test                              # bun:test suite, from the repo root
bun run knip                          # Unused files/deps/exports
bun run --filter @atelier/server check:boundary  # Server module-boundary rules
cd apps/agent-v2 && cargo test        # Agent tests (cargo clippy --all-targets for lint)
```

CI (`.github/workflows/ci.yml`) runs lint, check, typecheck and `bun test`,
plus `helm lint charts/atelier`.

## Critical Constraints

| Constraint | Rule | Why |
|------------|------|-----|
| **Sandbox agent** | Rust only, NO Bun/Node APIs | Lightweight static binary, no AVX dependency |
| **Server module boundaries** | `runtime/` never imports `control/`/`sessions/`; others use runtime's barrel only | Extraction seam; enforced by `check:boundary` |
| **Browser-safe shared barrel** | The `@frak/atelier-shared` root export stays Node-free; the Node loader is `@frak/atelier-shared/config-loader` | The console bundles the root barrel |
| **Hub isolation** | `apps/hub` imports `@atelier/knowledge` only, never `apps/server` | Separate deployable, talks to Atelier through its public API |
| **K8s Ingress** | Per-tool Ingress created via `KubeClient` (`buildToolIngress`) | Host-based routing for sandbox tools |

## Runtimes

| Component | Runtime | Why |
|-----------|---------|-----|
| Server API | **Bun** | Performance, native Elysia |
| Console | **Vite/Browser** | React SPA, static deploy (nginx) |
| Sandbox Agent | **Rust** | Lightweight, static musl binary |
| CLI | **Node ≥ 22.12** | Published to npm (`npx @konfeature/atelier`), talks to the server API |

## Conventions

- **Biome**: 80-char lines, double quotes, always semicolons, 2-space indent
- **TypeScript**: Strict mode, `noUncheckedIndexedAccess`, bundler resolution,
  relative imports keep their `.ts` extension
- **Logging**: `createChildLogger("name")` — always use child logger with context
- **Errors**: `SandboxError` hierarchy in `apps/server/src/shared/errors.ts` —
  `NotFoundError`, `ValidationError`, `ConflictError`, `ForbiddenError`,
  `UnauthorizedError`, `ResourceExhaustedError`
- **DI**: Manual wiring in `apps/server/src/api/container.ts`; routes get their
  services from the container, never construct them
- **Server modes** (`ATELIER_SERVER_MODE`): `mock` (everything stubbed, the
  `dev` script default), `local` (real Docker sandboxes, auth bypassed —
  `atelier local up`), `production` (real cluster + GitHub OAuth)
- **Tests**: `bun:test`, colocated as `*.test.ts` next to the code under
  test (e.g. `apps/server/src/runtime/runtime.lifecycle.test.ts`). Run the
  whole suite with `bun test` from the repo root; CI runs the same command

See each app's AGENTS.md for component-specific guidelines.

For code patterns and DI details, see [docs/patterns.md](docs/patterns.md).
For critical gotchas, see [docs/constraints.md](docs/constraints.md).
For network, domains, and cleanup, see [docs/infrastructure.md](docs/infrastructure.md).
For full architecture, see [docs/architecture.md](docs/architecture.md).
