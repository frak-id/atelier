# Infrastructure

Low-level services for Linux host management. All are singletons except `FirecrackerClient` (per-VM instance).

## Services

| Service | Purpose | Protocol |
|---------|---------|----------|
| `FirecrackerClient` | VM lifecycle control | Unix socket |
| `NetworkService` | IP/MAC allocation, TAP devices | Shell commands |
| `StorageService` | LVM volume cloning | Shell commands |
| `CaddyService` | Dynamic route registration | HTTP (admin API) |
| `AgentClient` | Communicate with in-VM agent | Raw HTTP over vsock |
| `SshPiperService` | SSH proxy configuration | Filesystem |
| `RegistryService` | Verdaccio npm registry | Shell + HTTP |

## AgentClient Note

Uses raw HTTP over Firecracker vsock (not standard HTTP client) because Bun's polyfill doesn't support vsock. Opens fresh connection per request.

For constraints on LVM flags and Caddy ordering, see [docs/constraints.md](../../../../docs/constraints.md).
