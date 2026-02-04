# Modules

Service and Repository classes for business logic. Routes are NOT here — they live in `api/`.

## Pattern

Each module follows: `index.ts` (barrel) → `service.ts` (logic) → `repository.ts` (Drizzle ORM). Services receive repositories via constructor. Wired in `container.ts`.

## Modules

| Module | Service | Repository | Notes |
|--------|---------|------------|-------|
| `sandbox` | Yes | Yes | + `SandboxProvisionService` for post-boot provisioning |
| `workspace` | Yes | Yes | |
| `task` | Yes | Yes | |
| `config-file` | Yes | Yes | |
| `git-source` | Yes | Yes | |
| `ssh-key` | Yes | Yes | |
| `session-template` | Yes | No | Template discovery + merging |
| `internal` | Yes | No | Facade for `AuthSyncService` + config sync |
| `shared-auth` | No | Yes | Used by AuthSyncService |

For code examples, see [docs/patterns.md](../../../../docs/patterns.md).
