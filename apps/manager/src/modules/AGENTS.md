# Modules

Service and Repository classes for business logic. **Routes are NOT here** - they live in `src/api/`.

## Module Structure

```
{module}/
├── index.ts              # Barrel: export Service + Repository
├── {module}.service.ts   # Business logic class
└── {module}.repository.ts # Data access (Drizzle ORM)
```

## Modules

| Module | Has Service | Has Repository | Notes |
|--------|-------------|----------------|-------|
| `sandbox` | Yes | Yes | + `sandbox.provisioner.ts` for rootfs injection |
| `workspace` | Yes | Yes | |
| `task` | Yes | Yes | |
| `config-file` | Yes | Yes | |
| `git-source` | Yes | Yes | |
| `ssh-key` | Yes | Yes | |
| `session-template` | Yes | No | Uses other services |
| `internal` | Yes | No | Uses SharedAuthRepository |
| `shared-auth` | No | Yes | Repository only, used by internal |
| `auth` | No | No | Just exports, wiring only |
| `health` | No | No | Routes-only (in src/api/) |
| `image` | No | No | Routes-only (in src/api/) |
| `system` | No | No | Routes-only (in src/api/) |
| `github` | No | No | Routes-only (in src/api/) |
| `shared-storage` | No | No | Routes-only (in src/api/) |

## Service Pattern

Services receive repositories via constructor:

```typescript
export class WorkspaceService {
  constructor(private readonly repository: WorkspaceRepository) {}
  
  getAll(): Workspace[] {
    return this.repository.getAll();
  }
  
  getByIdOrThrow(id: string): Workspace {
    const workspace = this.repository.getById(id);
    if (!workspace) throw new NotFoundError("Workspace", id);
    return workspace;
  }
}
```

## Repository Pattern

Repositories handle Drizzle ORM queries:

```typescript
export class WorkspaceRepository {
  getAll(): Workspace[] {
    return db.select().from(workspaces).all().map(rowToWorkspace);
  }
  
  getById(id: string): Workspace | undefined {
    const row = db.select().from(workspaces).where(eq(workspaces.id, id)).get();
    return row ? rowToWorkspace(row) : undefined;
  }
}
```

## Wiring

All services are instantiated in `src/container.ts`:

```typescript
const workspaceRepository = new WorkspaceRepository();
const workspaceService = new WorkspaceService(workspaceRepository);
export { workspaceService };
```

Routes import from container (NOT directly from modules):

```typescript
// src/api/workspace.routes.ts
import { workspaceService } from "../container.ts";
```

## Where to Look

| Task | File |
|------|------|
| Workspace CRUD | `workspace/workspace.service.ts` |
| Sandbox state | `sandbox/sandbox.service.ts` |
| RootFS file injection | `sandbox/sandbox.provisioner.ts` |
| Task management | `task/task.service.ts` |
| Config file merging | `config-file/config-file.service.ts` |
| Git source management | `git-source/git-source.service.ts` |
| SSH key CRUD | `ssh-key/ssh-key.service.ts` |
| Session templates | `session-template/session-template.service.ts` |

## See Also

- **[../orchestrators/AGENTS.md](../orchestrators/AGENTS.md)** - Complex multi-step workflows
- **[../../../../docs/patterns.md](../../../../docs/patterns.md)** - DI and error handling patterns
