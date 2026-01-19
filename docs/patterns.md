# Code Patterns

## Service Pattern (Manager)

Services are singleton objects, not classes:

```typescript
export const MyService = {
  async spawn(options: Options): Promise<Result> {
    // implementation
  },
};
```

## Logging

```typescript
import { createChildLogger } from "../lib/logger.ts";

const log = createChildLogger("service-name");
log.info({ data }, "Message");
```

## Module Structure

Standard: `index.ts` (barrel) -> `*.routes.ts` -> `*.service.ts` -> `*.repository.ts`

```
{module}/
├── index.ts              # Barrel: export routes + service
├── {module}.routes.ts    # Elysia route definitions
├── {module}.service.ts   # Business logic
└── {module}.repository.ts # Data access (Drizzle)
```

## Dependency Injection

Wire services at startup in `index.ts`:

```typescript
initSandboxService({
  getWorkspace: (id) => WorkspaceService.getById(id),
  getGitSource: (id) => GitSourceService.getById(id),
});
```

## Error Handling

```typescript
import { NotFoundError, ValidationError } from "@frak-sandbox/shared/errors.ts";

throw new NotFoundError("Sandbox not found");
throw new ValidationError("Invalid configuration");
```

## Routes

Use Elysia schema validation for all endpoints. See `apps/manager/src/modules/*/` for examples.

## Repository

Uses Drizzle ORM with bun:sqlite. Repository files handle all database access.
