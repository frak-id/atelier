# Sandbox Agent

Lightweight HTTP agent running INSIDE Firecracker VMs. Serves over vsock (primary) and TCP port 9999 (fallback).

## Runtime: Deno

```bash
# Run agent (inside VM)
deno run --allow-all --unstable-vsock src/index.ts

# Typecheck
deno check src/index.ts
```

Uses `Deno.serve()` with native vsock support. No npm dependencies.

## Transport

- **Primary**: vsock (CID 4294967295 / VMADDR_CID_ANY, port 9998) — host communicates via FC Unix socket
- **Fallback**: TCP on port 9999 — for backward compatibility and debugging

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Agent + services status |
| GET | `/metrics` | CPU, memory, disk metrics |
| POST | `/exec` | Execute shell command |
| POST | `/exec/batch` | Execute multiple commands |
| GET | `/config` | Sandbox config |
| GET | `/editor-config` | VSCode + OpenCode config |
| GET/POST | `/apps` | App port registration |
| DELETE | `/apps/:port` | Unregister app |
| GET | `/dev` | List dev commands |
| POST | `/dev/:name/start` | Start dev command |
| POST | `/dev/:name/stop` | Stop dev command |
| GET | `/dev/:name/logs` | Get dev command logs |

## Conventions

- **No Bun or Node.js APIs** — Deno native only
- No npm dependencies — self-contained
- Flat route structure with simple URL pattern matching
- Shell execution via `Deno.Command`
- Source files copied directly into VM rootfs (no build step)

## See Also

- [Infrastructure](../../../docs/infrastructure.md) - VM communication details
- [Constraints](../../../docs/constraints.md) - Runtime rules
