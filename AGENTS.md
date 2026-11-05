# Atelier

Orchestrator for isolated dev environments for coding agents: Kubernetes +
Kata Containers in production, a Docker backend for the single-user local
mode. Bun monorepo + a Rust in-pod agent. Product overview: `README.md`.

## Structure

```
apps/
├── server/   # @atelier/server: Bun/Elysia (see apps/server/AGENTS.md)
├── console/  # @atelier/console: React 19 SPA (Vite, TanStack Router)
└── agent/    # in-pod agent (`atelier-agent`, Rust, static musl, scratch image)
packages/
└── spec/     # @atelier/spec: SandboxSpec seam contract + shared wire types
infra/k8s/    # server + console manifests (infra/k8s/README.md); cluster infra is NOT deployed from this repo
infra/nginx/  # console nginx config (SPA + reverse proxy to the server)
scripts/      # bump-version.ts
docker-compose.local.yml  # local mode: server + console on host networking
Dockerfile    # multi-target: `server` and `console` images
```

## Where To Look

| Task | Location |
|------|----------|
| Add an HTTP route | `apps/server/src/api/` (services come from `container.ts`) |
| Add or change an MCP tool | `apps/server/src/api/mcp/tools/` (pinned by `surface.test.ts`) |
| Logic shared by HTTP and MCP | `apps/server/src/api/app/` |
| Sandbox lifecycle, backends, prebuilds | `apps/server/src/runtime/` |
| Identity, orgs, secrets, toolboxes, config keys | `apps/server/src/control/` |
| Agent tasks and ACP | `apps/server/src/sessions/` |
| Harnesses (opencode, pi) | `apps/server/src/harnesses/` |
| Config schema, loader, env vars | `apps/server/src/config/` |
| Base images | `apps/server/src/runtime/registry/seeds/` |
| In-sandbox agent | `apps/agent/src/` (Rust, no Bun/Node) |
| Console UI | `apps/console/src/components/` + `routes/` |
| SandboxSpec and wire types | `packages/spec/src/` |
| Deploy manifests | `infra/k8s/` |

## Commands

```bash
bun install
bun run --filter @atelier/server dev   # server, local mode + Docker backend, :4000 (needs Docker)
bun run --filter @atelier/console dev  # console on :5174, proxies API paths to :4000
bunx biome ci .                        # lint + format, read-only (what CI runs)
bun run check                          # biome check --write (applies fixes)
bun run typecheck                      # tsc --noEmit, every workspace
bun run test                           # bun test --isolate, from the repo root
bun run knip                           # unused files, deps, exports
bun run --filter @atelier/server check:boundary   # server module boundaries
bun run --filter @atelier/server generate-schema  # regenerate apps/server/schemas/*.json
cd apps/agent && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
shellcheck -s bash apps/agent/scripts/*.sh
```

CI (`.github/workflows/ci.yml`) runs `biome ci`, typecheck, `check:boundary`,
`bun run test`, and in the agent job shellcheck, clippy and `cargo test`.

Local mode without the dev script: `docker compose -f docker-compose.local.yml up`.

## Critical Constraints

| Constraint | Rule | Why |
|------------|------|-----|
| Sandbox agent | Rust only, no Bun/Node APIs | Static binary; Bun crashes in Kata VMs (AVX) |
| Server module boundaries | See `apps/server/AGENTS.md` | Extraction seam; enforced by `check:boundary` |
| Agent auth | Every agent HTTP route except `GET /health` and both WS listeners need the sandbox bearer token | A sandbox can reach other pods; NetworkPolicy is the first line, the token the second |
| Console imports | Only `@atelier/spec` and `import type { App } from "@atelier/server"` | Keeps server and Bun code out of the browser bundle |
| K8s Ingress | Per-tool Ingress via `KubeClient` (`buildToolIngress`) | Host-based routing for sandbox tools |

## Conventions

- **Biome**: 80-char lines, double quotes, semicolons, 2-space indent.
- **TypeScript**: strict, `noUncheckedIndexedAccess`, bundler resolution,
  relative imports keep the `.ts` extension.
- **Logging**: `createChildLogger("name")`.
- **Errors**: `SandboxError` hierarchy in `apps/server/src/shared/errors.ts`
  (`NotFoundError`, `ValidationError`, `ConflictError`, `ForbiddenError`,
  `UnauthorizedError`, `ResourceExhaustedError`).
- **DI**: manual wiring in `apps/server/src/api/container.ts`. Routes and MCP
  tools get services from the container and never construct them.
- **Server modes** (`ATELIER_SERVER_MODE`): `production` (cluster, GitHub
  OAuth, the default) and `local` (auth bypassed, single user, typically the
  Docker backend via `ATELIER_RUNTIME_BACKEND=docker`). There is no mock mode.
- **Tests**: `bun:test`, colocated as `*.test.ts`. Run with `bun run test`
  (`bun test --isolate`). `--isolate` is still required: config is read once
  at import, and several server test files set `ATELIER_SERVER_MODE` to
  `local` or `production` (for example `api/fork.routes.test.ts` and
  `api/sandbox-access.routes.test.ts`), so each needs a fresh module
  registry. Tests also swap the shared database through `setDatabase`. Plain `bun test` shares one registry and fails depending on file
  order. Tests that need a database use `useTestDatabase()`
  (`apps/server/src/runtime/test-database.ts`), a fresh `:memory:` DB with the
  real migrations. Runtime tests use `FakeBackend` and `FakeAgentClient` from
  `runtime.test-support.ts`.
- **Schema changes**: edit the Drizzle schema, then `bun run --filter
  @atelier/server db:generate`. Migrations live in `apps/server/drizzle` and
  run at boot.

More detail: [docs/patterns.md](docs/patterns.md),
[docs/constraints.md](docs/constraints.md),
[docs/architecture.md](docs/architecture.md),
[docs/advanced-configuration.md](docs/advanced-configuration.md).
