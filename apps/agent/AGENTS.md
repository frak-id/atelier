# Sandbox Agent

Lightweight HTTP agent running INSIDE Firecracker VMs on port 9999.

## Critical: Node.js Only

```bash
# Bun crashes inside Firecracker (SIGILL - AVX instructions)
bun build --bundle --target=node --outfile=dist/agent.mjs src/index.ts
```

Uses `@elysiajs/node` adapter to run Elysia on Node.js.

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Agent + services status |
| POST | `/exec` | Execute shell command |
| GET/POST | `/git/*` | Git operations |
| GET/POST | `/vscode/*` | code-server management |
| GET/POST | `/services/*` | systemd management |
| GET/POST | `/config/*` | Runtime config |

## Conventions

- **No Bun-specific APIs** - use Node.js compatible only
- Flat route structure (no nested modules)
- Shell execution via `child_process.exec`
- Services managed via `systemctl` commands
- `dist/agent.mjs` is committed (copied into rootfs during image build)

## See Also

- [Infrastructure](../../../docs/infrastructure.md) - VM communication details
- [Constraints](../../../docs/constraints.md) - Bun vs Node.js runtime rules
