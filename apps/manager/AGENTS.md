# Manager API

Elysia HTTP server orchestrating Firecracker VMs. Runs on Bun, port 4000.

## Architecture

Routes → `container.ts` (DI wiring) → Services → Repositories (Drizzle ORM).

Routes are **separated from modules** to break circular dependencies. All routes import services from `container.ts`, never directly from modules.

## Key Areas

- **api/** — Route handlers only. Import services from `container.ts`.
- **modules/** — Service + Repository classes. No routes here. See [modules guide](src/modules/AGENTS.md).
- **infrastructure/** — Low-level services (Firecracker, Network, LVM, Caddy, Agent). See [infrastructure guide](src/infrastructure/AGENTS.md).
- **orchestrators/** — Multi-step workflows with rollback. See [orchestrators guide](src/orchestrators/AGENTS.md).
- **schemas/** — TypeBox validation schemas.
- **shared/** — Errors, logger, config utilities.

## Initialization Order

Database must init first → cron jobs → cleanup → rehydrate network state → register Caddy routes → listen.

For code patterns and examples, see [docs/patterns.md](../../docs/patterns.md).
