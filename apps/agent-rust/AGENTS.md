# Sandbox Agent

Lightweight HTTP agent running INSIDE Firecracker VMs. Rust runtime — no Bun/Node APIs.

## Build

```bash
cargo build --release --target x86_64-unknown-linux-musl
```

Release profile optimized for size: `opt-level=z`, LTO, stripped. Produces ~2MB static binary.

## Transport

Vsock only (port 9998).

## Conventions

- Raw Hyper (no framework) for minimal binary size
- Shell execution via `tokio::process::Command`

