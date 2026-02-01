# Sandbox Agent

Lightweight HTTP agent running INSIDE Firecracker VMs. Deno runtime — no Bun/Node APIs.

## Build & Run

```bash
deno run --allow-all --unstable-vsock src/index.ts
deno compile --allow-all --unstable-vsock --target x86_64-unknown-linux-gnu --output dist/sandbox-agent src/index.ts
```

## Transport

Primary: vsock (port 9998). No npm dependencies, no build step — source copied directly into VM rootfs.

## Conventions

- Deno native APIs only (`Deno.serve`, `Deno.Command`)
- Flat route structure with URL pattern matching
- Self-contained — zero external dependencies
