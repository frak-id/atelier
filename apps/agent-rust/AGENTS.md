# Sandbox Agent (Rust)

Alternative Rust implementation of the in-VM sandbox agent. Mirrors the Deno agent's API.

## Runtime: Tokio + Hyper

```bash
# Build for Linux (musl, static binary)
cargo build --release --target x86_64-unknown-linux-musl

# Output: target/x86_64-unknown-linux-musl/release/sandbox-agent
```

Release profile: `opt-level=z`, LTO, single codegen unit, stripped — optimized for small binary size.

## Transport

- **vsock only** (CID VMADDR_CID_ANY, port 9998) — no TCP fallback unlike Deno agent

## API Endpoints

Same as Deno agent:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Agent + services status |
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

## Structure

```
src/
├── main.rs       # Vsock listener, connection handling
├── config.rs     # Constants (ports, paths)
├── router.rs     # URL routing → handler dispatch
└── routes/
    ├── mod.rs    # Route module declarations
    ├── health.rs # Health + service checks
    ├── exec.rs   # Shell command execution
    ├── config.rs # Sandbox config endpoint
    ├── dev.rs    # Dev command management
    └── apps.rs   # App port registration
```

## Conventions

- **No external HTTP framework** — raw Hyper for minimal binary size
- **No async runtime overhead** — Tokio multi-thread with direct vsock
- Shell execution via `tokio::process::Command`
- JSON via serde_json (no schema validation)
- Mirrors Deno agent API 1:1 for drop-in replacement

## Key Differences from Deno Agent

| Aspect | Deno Agent | Rust Agent |
|--------|------------|------------|
| Binary size | ~100MB (Deno runtime) | ~2MB (static musl) |
| Transport | vsock + TCP fallback | vsock only |
| Dependencies | Zero npm | tokio, hyper, serde |
| Build | `deno compile` | `cargo build --release` |

## See Also

- [Deno Agent](../agent/AGENTS.md) — Primary agent implementation
- [Constraints](../../docs/constraints.md) — Runtime rules
