# Sandbox Agent

Lightweight HTTP agent running INSIDE Kata Containers sandbox pods. Rust runtime — no Bun/Node APIs.

## Build

```bash
cargo build --release --target x86_64-unknown-linux-musl
```

Release profile optimized for size: `opt-level=z`, LTO, stripped. Produces ~2MB static binary.

## Transport

HTTP over TCP, port 9998. Config loaded from `/etc/sandbox/config.json` (K8s ConfigMap mount).

## Conventions

- Raw Hyper (no framework) for minimal binary size
- Shell execution via `tokio::process::Command`

