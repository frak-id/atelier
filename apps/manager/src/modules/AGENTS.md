# Modules

Business logic layer following `routes → service → repository` pattern.

## Standard Module

```
{module}/
├── index.ts              # Barrel: export routes + service
├── {module}.routes.ts    # Elysia route definitions
├── {module}.service.ts   # Business logic
└── {module}.repository.ts # Data access (Drizzle)
```

## Deviations

| Module | Pattern | Notes |
|--------|---------|-------|
| `sandbox` | Extended | + `builder.ts`, `provisioner.ts` |
| `github` | Split routes | `github-api.routes.ts`, `github-auth.routes.ts` |
| `prebuild` | Service-only | No routes, internal use by workspace |
| `health`, `image`, `system` | Routes-only | No service layer |

## Where to Look

| Task | File |
|------|------|
| VM creation orchestration | `sandbox/sandbox.builder.ts` |
| RootFS file injection | `sandbox/sandbox.provisioner.ts` |
| Workspace CRUD | `workspace/workspace.service.ts` |
| Pre-build snapshots | `prebuild/prebuild.service.ts` |
| GitHub OAuth flow | `github/github-auth.routes.ts` |

## Cross-Module Dependencies

```
health.routes → SandboxService
system.routes → SandboxService
github-*.routes → GitSourceService
workspace.routes → PrebuildService
sandbox.service → ConfigFileService (via DI)
```

## Sandbox Module (Complex)

**Builder flow:**
1. Validate workspace/image exists
2. Allocate IP + create TAP device
3. Clone LVM volume from base/prebuild
4. Mount volume, inject configs (`provisioner.ts`)
5. Spawn Firecracker process
6. Configure VM via socket API
7. Wait for agent health
8. Register Caddy routes

**Rollback on failure** (`sandbox.builder.ts:rollback()`):
Kill process → Remove socket → Delete LVM → Delete TAP → Release IP

## See Also

- [Patterns](../../../../docs/patterns.md) - Service pattern, DI, error handling
