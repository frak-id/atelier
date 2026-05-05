# Manager API

Elysia HTTP server orchestrating K8s sandbox pods (Kata Containers). Runs on Bun, port 4000.

## Architecture

Routes → `container.ts` (DI wiring) → Services → Repositories (Drizzle ORM).

Routes are **separated from modules** to break circular dependencies. All routes import services from `container.ts`, never directly from modules.

## Key Areas

- **api/** — Route handlers only. Import services from `container.ts`.
- **modules/** — Service + Repository classes. No routes here. See [modules guide](src/modules/AGENTS.md).
- **infrastructure/** — Low-level services (Kubernetes, Agent, Registry, Cron, Database). See [infrastructure guide](src/infrastructure/AGENTS.md).
- **orchestrators/** — Multi-step workflows with rollback. See [orchestrators guide](src/orchestrators/AGENTS.md).
- **schemas/** — TypeBox validation schemas.
- **shared/** — Errors, logger, config utilities.

## Initialization Order

Database must init first → cron jobs → cleanup → listen.

## Core Abstractions

- **Sandbox** is the universal compute primitive. Every spawn path — dashboard, task, opencode-plugin, slack/github, system bootstrap — produces a `Sandbox` row tagged with `origin: { source, externalId?, externalUrl? }`. Use the origin filter (`?originSource=...&originExternalId=...`) to look one up; never persist your own id→sandbox mapping.
- **Task** is the multi-session work-item with reply semantics (kanban + slack/github thread continuation). Tasks own a sandbox, manage multiple OpenCode sessions, and carry the platform-specific reply state. If you just need a sandbox to run code in, spawn one directly — don't wrap it in a task.
- **System sandboxes** are flagged via `origin.source: "system"` (no `workspaceId`). Filter them out of user-facing lists with that predicate.

For code patterns and examples, see [docs/patterns.md](../../docs/patterns.md).
