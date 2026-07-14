# Code Patterns

## Server Architecture

`apps/server` is one deployable split into three internal modules with import
boundaries enforced by `scripts/check-boundaries.ts` (not just convention),
plus an HTTP shell that wires them together:

| Layer | Responsibility |
|-------|----------------|
| `api/` | Elysia route handlers, schema validation, imports from `container.ts` |
| `api/container.ts` | Composition root wiring `runtime` + `control` + `sessions` together |
| `runtime/` | Mechanism: prebuild/boot/pause/resume/destroy, files/env/processes/ports/hooks/exec/attach, Kubernetes builders, CSI snapshots, agent client. Takes `SandboxSpec`, never identity. |
| `control/` | Policy: identity (users/orgs/org-members), API keys, SSH keys, saved specs, secrets, org policy, toolboxes — plus the seam-crossing enrichment steps. Owns its own composition root (`control/container.ts`). |
| `control/modules/` | Business logic (Services) and Data Access (Repositories) for control-plane entities. |
| `sessions/` | Agent app-tier: the ACP client + session facade — a privileged client of `runtime`, never imported by it. |

See `apps/server/AGENTS.md` for the full module-boundary rules.

## Service Patterns

We use three distinct patterns depending on the service's role:

1. **Module Services**: Classes with constructor DI. Used for business logic.
2. **Infrastructure**: Singleton/composed objects (e.g. `AgentClient`, `RuntimeService`). Used for low-level host integrations.
3. **Stateless Helpers**: Exported functions. Used for pure logic.

## Dependency Injection

`apps/server/src/api/container.ts` is the top-level composition root — the
only place `runtime`, `control`, and `sessions` are wired together. `control`
has its own nested composition root, `apps/server/src/control/container.ts`,
scoped to identity/orgs/secrets/saved-specs/toolboxes. All dependencies are
manually wired, no DI framework.

```ts
// apps/server/src/api/container.ts
export function createServerContainer() {
  const control = createControlContainer();
  const agent = new AgentClient();
  const runtime = new RuntimeService({
    agent,
    sandboxes: new DrizzleSandboxStore(),
    snapshots: new DrizzleSnapshotStore(),
    toolsets: new DrizzleToolsetStore(),
    sandboxToolsetRefs: new DrizzleSandboxToolsetRefStore(),
  });
  const sessions = new SessionService({ runtime, surface: /* ... */ });
  // ...
  return { control, runtime, agent, sessions /* ... */ };
}
```

**Rule**: Routes MUST import from `container.ts`, never directly from `runtime/control/sessions` internals.

## Module Structure

Control-plane modules contain business logic and data access; they do NOT
contain routes.

```
apps/server/src/control/modules/{name}/
├── index.ts              # Barrel: export Service + Repository
├── {name}.service.ts     # Business logic class
└── {name}.repository.ts  # Data access class (Drizzle)
```

Examples: `user`, `organization`, `org-member`, `org-policy`, `api-key`,
`ssh-key`, `saved-spec`, `secret`, `server-config`, `toolbox`,
`toolbox-version`.

## Routes

Routes live in `apps/server/src/api/` (`v1.routes.ts` → runtime,
`control.routes.ts` → control CRUD, `sessions.routes.ts` → sessions,
`mcp/` → MCP surface, `auth.routes.ts` → GitHub OAuth). They define Elysia
handlers and validation schemas, importing all dependencies from
`container.ts`.

## Error Handling

Errors are defined in `apps/server/src/shared/errors.ts`.

```ts
import { NotFoundError, ValidationError } from "../shared/errors.ts";

// NotFoundError(resource, id)
throw new NotFoundError("Sandbox", sandboxId);
throw new ValidationError("Invalid configuration");
```

`SandboxError` subclasses (`NotFoundError`, `ForbiddenError`,
`ResourceExhaustedError`, `UnauthorizedError`, `ConflictError`,
`ValidationError`) are automatically mapped to HTTP responses in
`apps/server/src/api/index.ts` via the `.onError()` handler.

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
