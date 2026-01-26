# Manager API

Elysia HTTP server orchestrating Firecracker VMs. Runs on Bun, port 4000.

## Structure

```
src/
├── api/               # Route handlers (imports from container.ts)
├── modules/           # Service + Repository classes (NO routes)
├── infrastructure/    # Low-level services (FC, Network, LVM, Caddy)
├── orchestrators/     # Complex workflows (spawner, destroyer)
├── schemas/           # TypeBox validation schemas
├── shared/            # Errors, logger, config
└── container.ts       # Dependency injection wiring
```

## Architecture

```
api/*.routes.ts  →  container.ts  →  modules/*.service.ts  →  modules/*.repository.ts
     │                   │                    │                        │
  HTTP layer      DI wiring         Business logic              Database (Drizzle)
```

Routes are **separated from modules** to break circular dependencies. All routes import services from `container.ts`.

## Where to Look

| Task | Location |
|------|----------|
| Add API endpoint | `src/api/{module}.routes.ts` |
| Add business logic | `src/modules/{module}/{module}.service.ts` |
| Add data access | `src/modules/{module}/{module}.repository.ts` |
| Add infrastructure | `src/infrastructure/{service}/` |
| Add complex workflow | `src/orchestrators/` |
| Wire dependencies | `src/container.ts` |
| Add validation schema | `src/schemas/{module}.ts` |

## Code Patterns

**Service Class** (receives repository via constructor):
```typescript
export class WorkspaceService {
  constructor(private readonly repository: WorkspaceRepository) {}
  
  getById(id: string): Workspace | undefined {
    return this.repository.getById(id);
  }
}
```

**Repository Class** (Drizzle ORM):
```typescript
export class WorkspaceRepository {
  getById(id: string): Workspace | undefined {
    const row = db.select().from(workspaces).where(eq(workspaces.id, id)).get();
    return row ? rowToWorkspace(row) : undefined;
  }
}
```

**Route Handler** (imports from container):
```typescript
import { workspaceService } from "../container.ts";

export const workspaceRoutes = new Elysia({ prefix: "/workspaces" })
  .get("/:id", ({ params }) => {
    const workspace = workspaceService.getById(params.id);
    if (!workspace) throw new NotFoundError("Workspace", params.id);
    return workspace;
  });
```

**Logging** (always use child logger):
```typescript
const log = createChildLogger("workspace-service");
log.info({ workspaceId }, "Creating workspace");
```

**Errors** (custom hierarchy in `shared/errors.ts`):
```typescript
throw new NotFoundError("Sandbox", id);      // 404
throw new ValidationError("Invalid config"); // 400
throw new ResourceExhaustedError("sandboxes"); // 429
```

**Mock Mode** (local dev without Firecracker):
```bash
SANDBOX_MODE=mock bun run dev
```

All infrastructure services check `config.isMock()` and return mock responses.

## Initialization Order

```typescript
1. await initDatabase()           // Must be first
2. CronService.add(...)           // Schedule jobs
3. sshKeyService.cleanupExpired() // Cleanup
4. NetworkService.markAllocated() // Rehydrate state
5. CaddyService.registerRoutes()  // Re-register routes
6. app.listen(port)               // Start server
```

## Layer Guides

- **[Modules](src/modules/AGENTS.md)** - Service + Repository classes
- **[Infrastructure](src/infrastructure/AGENTS.md)** - Low-level services
- **[Orchestrators](src/orchestrators/AGENTS.md)** - Complex workflows
