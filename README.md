# L'Atelier

Firecracker microVM orchestrator for isolated development environments.

**Self-hosted sandboxes with VM-level isolation, instant boot (<200ms), and a simple CLI.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

## Why L'Atelier?

Most sandbox tools use containers — fast, but with weak isolation boundaries. L'Atelier uses [Firecracker](https://firecracker-microvm.github.io/) microVMs (the technology behind AWS Lambda) to give each sandbox **hardware-level isolation** while keeping boot times under 200ms via LVM copy-on-write snapshots.

- **VM isolation** — each sandbox is a real virtual machine, not a container namespace
- **Instant startup** — LVM thin snapshots clone a full environment in <5ms
- **Prebuilds** — run expensive setup once, snapshot it, spawn instantly from there
- **Simple operations** — single CLI, no Kubernetes, no complex orchestration

## Quickstart

```bash
curl -fsSL https://raw.githubusercontent.com/frak-id/oc-sandbox/main/infra/scripts/install.sh | bash
```

After install:

```bash
atelier manager status
```

## Requirements

- Debian 12 (systemd)
- Bare‑metal KVM (`/dev/kvm` present)
- x86_64 CPU
- A domain with wildcard DNS (`*.your-domain.com` → server IP)
- Ports `80` and `443` open for HTTPS

## Key Commands

| Command | Description |
|---------|-------------|
| `atelier init` | Full install (config + setup + update + images) |
| `atelier update` | Download + install server bundle |
| `atelier images build dev-base` | Build base image |
| `atelier manager status` | Manager health check |
| `atelier debug-vm start` | Test VM for validation |

## Configuration

Default config path: `/etc/atelier/sandbox.config.json`
Override with `ATELIER_CONFIG=/path/to/sandbox.config.json`

If you pre‑fill `setup.storage` or `setup.network` in the config, the CLI will
skip prompts during `atelier init`.

## Local Development

No server or KVM needed — the manager runs in mock mode:

```bash
bun install
ATELIER_SERVER_MODE=mock bun run dev
# API:       http://localhost:4000
# Swagger:   http://localhost:4000/swagger
# Dashboard: http://localhost:5173
```

## Documentation

- [Setup Guide](docs/setup.md) — installation and configuration
- [Architecture](docs/architecture.md) — system design, components, and diagrams
- [Infrastructure](docs/infrastructure.md) — networking, storage, domains, and deployment
- [Constraints](docs/constraints.md) — critical gotchas that will save you hours
- [Code Patterns](docs/patterns.md) — conventions for contributors

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

[MIT](LICENSE.md)
