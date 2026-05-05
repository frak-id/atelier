# Orchestrators

Complex multi-step workflows coordinating services and infrastructure. Use context-based execution with automatic rollback on failure.

## Orchestrators

| Orchestrator | Purpose |
|--------------|---------|
| `SandboxSpawner` | Full sandbox creation (K8s pod + service + ingress → agent → provision) |
| `TaskSpawner` | Task execution (sandbox → git branch → prompt → session) |
| `PrebuildRunner` | Prebuild image creation via Kaniko + Zot |
| `SandboxLifecycle` | Health monitoring and state management (pod status) |
| `PrebuildChecker` | Staleness detection and rebuild triggers |
| `SandboxDestroyer` | K8s resource cleanup (label-based delete) |

## Origin Stamping

Every spawned sandbox should carry an `origin: { source, externalId?, externalUrl? }`:

- `SandboxSpawner` accepts `options.origin` and stores it verbatim
- `TaskSpawner` stamps `{ source: "task", externalId: task.id }`
- `SystemSandboxService` stamps `{ source: "system" }` and leaves `workspaceId` undefined
- The opencode-plugin stamps `{ source: "opencode-plugin", externalId: <oc workspaceId> }`

Origin is set at creation time and never mutated. Lookups use `findByOrigin(source, externalId)` so callers don't need to persist their own id→sandbox mapping.

## Key Pattern

Orchestrators create a `Context` object that tracks allocated resources. On failure, `rollback()` cleans up K8s resources via label-based deletion.

## When to Add an Orchestrator

- Multi-step workflow with rollback requirements
- Coordination across 3+ services/infrastructure
- State machine behavior (status transitions)
