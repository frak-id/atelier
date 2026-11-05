# Code Patterns

## Server Architecture

`apps/server` is one deployable split into internal modules with import
boundaries enforced by `apps/server/scripts/check-boundaries.ts` (not just
convention), plus an HTTP and MCP shell that wires them together:

| Layer | Responsibility |
|-------|----------------|
| `api/` | Elysia route handlers and MCP tools: validation, auth, thin calls into the application layer |
| `api/app/` | Application layer under HTTP and MCP (`SandboxOps`, `ToolboxOps`): validation, org resolution, job tracking, auto-resume. No routes, no MCP, no elysia. |
| `api/container.ts` | Composition root wiring `runtime` + `control` + `sessions` + `api/app` |
| `runtime/` | Mechanism: prebuild/boot/pause/resume/destroy, files/processes/ports/hooks/exec/attach, Kubernetes and Docker backends, CSI snapshots, agent client. Takes `SandboxSpec`, never identity. |
| `control/` | Policy: identity (users, orgs, members), the default org and server admins, API keys, SSH keys, secrets, toolboxes, the server config plane, and the seam-crossing enrichment steps. Owns a nested composition root (`control/container.ts`). |
| `control/modules/` | Business logic (Services) and data access (Repositories) for control-plane entities. |
| `sessions/` | Agent app-tier: the ACP client, session facade and persisted agent tasks. A privileged client of `runtime`, never imported by it. |
| `harnesses/` | Pure harness definitions (opencode, pi) and `mergeSpecs`. A leaf module, applied by `control/enrichment.ts`. |
| `config/` | Config schema, loader, constants. A leaf module. |
| `shared/` | Errors, logger, db handle, `runtime-config`. May import `config/` only. |

Boundary rules and the reasons are in `apps/server/AGENTS.md`.

## Service Patterns

Three patterns, depending on the service's role:

1. **Module Services**: classes with constructor DI, for business logic.
2. **Infrastructure**: composed objects (`AgentClient`, `RuntimeService`), for
   low-level host integrations.
3. **Stateless Helpers**: exported functions, for pure logic.

## Dependency Injection

`apps/server/src/api/container.ts` is the top-level composition root and the
only place `runtime`, `control` and `sessions` are wired together. `control`
has its own nested root. All wiring is manual, with no DI framework.
`RuntimeService` takes its stores and collaborators as constructor deps and
defaults to the real Drizzle stores; tests pass `FakeBackend` and
`FakeAgentClient` (`runtime/runtime.test-support.ts`) and call
`useTestDatabase()` for a real in-memory SQLite.

```ts
// apps/server/src/api/container.ts (abridged)
export function createServerContainer() {
  const control = createControlContainer();
  bindRuntimeConfig((key) => control.serverConfigService.get(key));
  const backend = createSandboxBackend();
  const agent = new AgentClient(
    (id) => backend.resolveAgentEndpoint(id),
    (id) => sandboxStore.get(id)?.generated?.agentPassword,
  );
  const runtime = new RuntimeService({
    agent,
    backend,
    sandboxes: sandboxStore,
    resolveBootSpec: (spec) => control.resolveBootSpec(spec),
    // ...stores
  });
  const toolboxOps = new ToolboxOps({ runtime, control, jobs });
  const sandboxOps = new SandboxOps({ runtime, control, jobs, toolboxes: toolboxOps, idle });
  // ...
}
```

**Rule**: routes and MCP tools get services from the container and never
import `runtime`, `control` or `sessions` internals.

**Rule**: runtime code that needs an operational config key reads it through
`shared/lib/runtime-config.ts`. The container binds the getter, so `runtime/`
never imports `control/`.

## Stored specs hold references

A stored `SandboxSpec` keeps `{"$secret": "NAME"}` references and no git
credentials. `control.resolveBootSpec` resolves them at every boot, and the
runtime refuses to boot a spec that still contains an unresolved reference.
Never write a resolved value into a stored spec.

## Module Structure

Control-plane modules hold business logic and data access, not routes.

```
apps/server/src/control/modules/{name}/
├── index.ts              # Barrel: export Service + Repository
├── {name}.service.ts     # Business logic class
└── {name}.repository.ts  # Data access class (Drizzle)
```

Examples: `user`, `organization`, `org-member`, `api-key`, `ssh-key`,
`secret`, `server-config`, `toolbox`, `toolbox-version`, `ownership-transfer`,
`idle-policy`.

## Routes

Routes live in `apps/server/src/api/`: `v1.routes.ts` (runtime),
`control.routes.ts` (control CRUD), `sessions.routes.ts` (sessions and tasks),
`auth.routes.ts` (OAuth, forward-auth, wake), and `mcp/` (the two MCP
endpoints). A route that needs a sandbox id registers after the access guard
(`api/sandbox-guard.ts`). Logic that HTTP and MCP both need goes in
`api/app/`, not in either surface.

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
`ValidationError`) map to HTTP responses in `apps/server/src/api/index.ts`
through `.onError()`. MCP tools wrap handlers in `safeTool(name, handler)`,
which turns them into tool errors and logs unexpected ones.

## Logging

Use child loggers.

```ts
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("service-name");
log.info({ data }, "Message");
```

In production (`NODE_ENV=production` and server mode `production`) logs also go
to `DATA_DIR/logs/server.log`, rotated at 20 MiB with three files kept.

## Config

`config/config.schema.ts` owns every key's type, default and env var. A key
that a server admin may edit from the console also has an entry in
`control/modules/server-config/registry.ts` (label, description, validator,
`plane: true`). `registry.test.ts` checks the two stay consistent. After
changing the schema, run `bun run --filter @atelier/server generate-schema`.
See [advanced-configuration.md](advanced-configuration.md).

## Repository

Drizzle ORM on `bun:sqlite`. Repository classes own all database access and
are injected into services. The runtime and sessions modules have their own
schema files (`runtime/db/schema.ts`, `sessions/db/schema.ts`) and no foreign
keys to identity tables.
