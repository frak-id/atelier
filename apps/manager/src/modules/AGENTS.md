# Modules

Service and Repository classes for business logic. Routes are NOT here — they live in `api/`.

## Pattern

Each module follows: `index.ts` (barrel) → `service.ts` (logic) → `repository.ts` (Drizzle ORM). Services receive repositories via constructor. Wired in `container.ts`.

## Modules

| Module | Service | Repository | Notes |
|--------|---------|------------|-------|
| `sandbox` | Yes | Yes | + `provisioner.ts` for rootfs injection |
| `workspace` | Yes | Yes | |
| `task` | Yes | Yes | |
| `config-file` | Yes | Yes | |
| `git-source` | Yes | Yes | |
| `ssh-key` | Yes | Yes | |
| `session-template` | Yes | No | Template discovery + merging |
| `internal` | Yes | No | Auth sync, config discovery, registry sync |
| `shared-auth` | No | Yes | Used by internal |

For code examples, see [docs/patterns.md](../../../../docs/patterns.md).
