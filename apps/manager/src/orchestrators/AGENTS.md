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

## Key Pattern

Orchestrators create a `Context` object that tracks allocated resources. On failure, `rollback()` cleans up K8s resources via label-based deletion.

## When to Add an Orchestrator

- Multi-step workflow with rollback requirements
- Coordination across 3+ services/infrastructure
- State machine behavior (status transitions)
