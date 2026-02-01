# Sandbox Agent (Rust)

Alternative Rust implementation of the in-VM agent. Mirrors the Deno agent's API as a drop-in replacement.

## Build

```bash
cargo build --release --target x86_64-unknown-linux-musl
```

Release profile optimized for size: `opt-level=z`, LTO, stripped. Produces ~2MB static binary vs ~100MB Deno.

## Transport

Vsock only (port 9998) — no TCP fallback unlike Deno agent.

## Conventions

- Raw Hyper (no framework) for minimal binary size
- Mirrors Deno agent endpoints 1:1
- Shell execution via `tokio::process::Command`
