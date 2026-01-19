# Infrastructure

Low-level services for Linux host management.

## Service Patterns

| Service | Pattern | Purpose |
|---------|---------|---------|
| `FirecrackerClient` | Class | Unix socket API to control VM |
| `NetworkService` | Singleton | IP/MAC allocation, TAP lifecycle |
| `StorageService` | Singleton | LVM volume cloning |
| `CaddyService` | Singleton | Admin API for route registration |
| `AgentClient` | Singleton | HTTP to VM's port 9999 |
| `QueueService` | Instance | Serializes concurrent spawns |

## Initialization Order

```typescript
// apps/manager/src/index.ts
1. await initDatabase()           // Must be first
2. setAgentSandboxStore(...)      // Cross-reference DI
3. initSandboxService(...)        // Wire dependencies
4. app.on("start", reconcile)     // Re-register Caddy routes
5. app.listen(...)                // Start server
```

## Where to Look

| Task | File |
|------|------|
| Firecracker API calls | `firecracker/firecracker.client.ts` |
| TAP device creation | `network/network.service.ts` |
| LVM snapshot cloning | `storage/lvm.service.ts` |
| Caddy route management | `proxy/caddy.service.ts` |
| VM agent communication | `agent/agent.client.ts` |

## Sandbox Build Flow

```
SandboxBuilder
    ├── NetworkService.allocate() → IP + MAC
    ├── NetworkService.createTap() → tap-{id}
    ├── StorageService.cloneVolume() → LVM snapshot
    ├── SandboxProvisioner.configure() → Mount + inject files
    ├── spawn("firecracker", args)
    ├── FirecrackerClient.configure() → Via socket
    ├── AgentClient.waitForAgent() → Poll :9999/health
    └── CaddyService.registerRoutes() → Subdomains
```

## See Also

- [Constraints](../../../../docs/constraints.md) - LVM flags, Caddy ordering, mock mode
- [Infrastructure](../../../../docs/infrastructure.md) - Network architecture, cleanup order
