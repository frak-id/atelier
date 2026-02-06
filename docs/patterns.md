# Code Patterns

## Manager Architecture

The Manager follows a layered architecture to ensure separation of concerns and
break circular dependencies.

| Layer | Responsibility |
|-------|----------------|
| `api/` | Elysia route handlers, schema validation, imports from `container.ts` |
| `container.ts` | Dependency Injection composition root |
| `modules/` | Business logic (Services) and Data Access (Repositories) |
| `orchestrators/` | Multi-step workflows with rollback (spawning, destroying) |
| `infrastructure/` | Low-level host/VM integrations (LVM, Caddy, Network) |

## Service Patterns

We use three distinct patterns depending on the service's role:

1. **Module Services**: Classes with constructor DI. Used for business logic.
2. **Infrastructure**: Singleton objects. Used for low-level host integrations.
3. **Stateless Helpers**: Exported functions. Used for pure logic.

## Dependency Injection

`apps/manager/src/container.ts` is the composition root. All dependencies are
manually wired here.

```ts
// apps/manager/src/container.ts
const taskRepository = new TaskRepository();
const taskService = new TaskService(taskRepository);
const sandboxSpawner = new SandboxSpawner({
  sandboxService,
  workspaceService,
  // ...
});

export { taskService, sandboxSpawner };
```

**Rule**: Routes MUST import from `container.ts`, never directly from modules.

## Module Structure

Modules contain business logic and data access. They do NOT contain routes.

```
apps/manager/src/modules/{name}/
├── index.ts              # Barrel: export Service + Repository
├── {name}.service.ts     # Business logic class
└── {name}.repository.ts  # Data access class (Drizzle)
```

**Exception**: Some modules like `sandbox` use the repository directly as the
service in `container.ts` if no additional business logic is required.

## Routes

Routes live in `apps/manager/src/api/`. They define Elysia handlers and
validation schemas, importing all dependencies from `container.ts`.

## Orchestrators

Orchestrators in `apps/manager/src/orchestrators/` coordinate complex,
multi-step workflows that span multiple modules or infrastructure services.
They typically use context objects and implement rollback logic on failure.

## Error Handling

Errors are defined in `apps/manager/src/shared/errors.ts`.

```ts
import { NotFoundError, ValidationError } from "../shared/errors.ts";

// NotFoundError(resource, id)
throw new NotFoundError("Sandbox", sandboxId);
throw new ValidationError("Invalid configuration");
```

`SandboxError` subclasses are automatically mapped to HTTP responses in
`apps/manager/src/index.ts` via the `.onError()` handler.

## Events

The system uses two event buses for different purposes:

- **eventBus** (`infrastructure/events/event-bus.ts`): Typed domain events
  (e.g., `sandbox.created`, `task.updated`). Consumed by the SSE route.
- **internalBus** (`infrastructure/events/internal-bus.ts`): Node EventEmitter
  for internal triggers (e.g., used by pollers).

## Logging

Always use child loggers to provide context.

```ts
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("service-name");
log.info({ data }, "Message");
```

## Repository

Uses Drizzle ORM with `bun:sqlite`. Repository classes handle all database
access and are injected into services.
