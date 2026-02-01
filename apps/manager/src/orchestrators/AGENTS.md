# Orchestrators

Complex multi-step workflows coordinating services and infrastructure. Use context-based execution with automatic rollback on failure.

## Orchestrators

| Orchestrator | Purpose |
|--------------|---------|
| `SandboxSpawner` | Full VM creation (network → volume → FC → agent → routes) |
| `TaskSpawner` | Task execution (sandbox → git branch → prompt → session) |
| `PrebuildRunner` | Prebuild snapshot creation |
| `SandboxLifecycle` | Health monitoring and state management |
| `PrebuildChecker` | Staleness detection and rebuild triggers |
| `SandboxDestroyer` | Cleanup in reverse order of creation |

## Key Pattern

Orchestrators create a `Context` object that tracks allocated resources. On failure, `rollback()` releases resources in **reverse order** (PID → socket → LVM → TAP → IP → Caddy).

## When to Add an Orchestrator

- Multi-step workflow with rollback requirements
- Coordination across 3+ services/infrastructure
- State machine behavior (status transitions)
