# Infrastructure

Low-level services for Linux host management.

## Service Patterns

| Service | Pattern | Purpose |
|---------|---------|---------|
| `FirecrackerClient` | Class | Unix socket API to control VM |
| `NetworkService` | Singleton | IP/MAC allocation, TAP lifecycle |
| `StorageService` | Singleton | LVM volume cloning |
| `CaddyService` | Singleton | Admin API for route registration |
| `AgentClient` | Singleton | Raw HTTP over vsock to VM agent |
| `QueueService` | Instance | Serializes concurrent spawns |
| `RegistryService` | Singleton | Verdaccio npm registry lifecycle |
| `SshPiperService` | Singleton | SSH proxy configuration |

## Communication Protocols

| Target | Protocol | Details |
|--------|----------|---------|
| Firecracker | Unix socket | JSON API via FC socket path |
| Agent (in VM) | Vsock | Raw HTTP over vsock (CID 4294967295, port 9998) |
| Caddy | HTTP | Admin API at localhost:2019 |
| LVM | Shell | `lvcreate`, `lvremove` via Bun.$ |

## Where to Look

| Task | File |
|------|------|
| Firecracker API calls | `firecracker/firecracker.client.ts` |
| FC process launch | `firecracker/firecracker.launcher.ts` |
| FC socket paths | `firecracker/firecracker.paths.ts` |
| TAP device creation | `network/network.service.ts` |
| LVM snapshot cloning | `storage/lvm.service.ts` |
| Caddy route management | `proxy/caddy.service.ts` |
| SSH proxy config | `proxy/sshpiper.service.ts` |
| VM agent communication | `agent/agent.client.ts` |
| Agent high-level ops | `agent/agent.operations.ts` |
| Database schema | `database/schema.ts` |

## Sandbox Build Flow

```
SandboxSpawner (orchestrator)
    ├── NetworkService.allocate() → IP + MAC
    ├── NetworkService.createTap() → tap-{id}
    ├── StorageService.cloneVolume() → LVM snapshot
    ├── SandboxProvisioner.configure() → Mount + inject files
    ├── spawn("firecracker", args)
    ├── FirecrackerClient.configure() → Via socket
    ├── AgentClient.waitForAgent() → Poll vsock /health
    └── CaddyService.registerRoutes() → Subdomains
```

## See Also

- [Constraints](../../../../docs/constraints.md) - LVM flags, Caddy ordering, mock mode
- [Infrastructure](../../../../docs/infrastructure.md) - Network architecture, cleanup order
