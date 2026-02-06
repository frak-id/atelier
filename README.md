# L'Atelier

Isolated dev environments that boot in milliseconds, not minutes.

**Self-hosted Firecracker microVM sandboxes — real VM isolation, instant snapshots, one CLI.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

## Batteries Included

Each sandbox is a complete development environment — VS Code, AI agent, and browser, accessible from any device.

- **[code-server](https://github.com/coder/code-server)** — VS Code in the browser, zero local setup
- **[OpenCode](https://github.com/anomalyco/opencode)** — AI coding agent, launch tasks and review results from anywhere
- **Chromium via [KasmVNC](https://kasmweb.com/kasmvnc)** — full browser inside your sandbox for previewing, testing, debugging
- **[Verdaccio](https://github.com/verdaccio/verdaccio)** — private npm registry shared across all sandboxes

Spawn a sandbox, push a task to OpenCode, close your laptop.
Review the results from your phone on the ski lift — or wherever you happen to be.

## Features

- **Two base images out of the box** — `dev-base` ships with Node 22 and Bun; `dev-cloud` extends it with AWS CLI, Google Cloud SDK, and kubectl
- **Workspace definitions** — configure git repos to clone, init commands, dev commands, exposed ports, secrets, and resource limits per workspace
- **OpenCode config replication** — define OpenCode configuration globally or per workspace, automatically replicated to every sandbox
- **Auth synchronization** — OAuth tokens are synced across all running sandboxes so you authenticate once and every instance just works (may violate ToS of some providers)
- **Package cache** — [Verdaccio](https://github.com/verdaccio/verdaccio) runs on the host as a shared npm registry, caching packages for npm, bun, pnpm, and yarn across all sandboxes
- **SSH access** — use your regular workflow: SSH, VS Code Remote SSH, JetBrains remote — the sandbox is a real Linux VM
- **Multi-dev per sandbox** — nothing stops multiple developers from working in the same sandbox simultaneously
- **Task dispatch** — create coding tasks from the dashboard, L'Atelier spawns a sandbox, creates a git branch, launches OpenCode with your prompt, and tracks progress. An AI task queue for your team
- **Session templates** — 4 built-in AI workflows (Implementation, Best Practices Review, Security Review, Simplification) with customizable models, effort levels, and prompt templates per workspace
- **Dashboard** — mission control for all your sandboxes: real-time task progress, running dev servers, and an attention feed aggregating OpenCode permission and question requests across every session
- **Dev commands with auto HTTPS** — define dev commands in your workspace config (e.g. `npm run dev` on port 3000) and get a public `https://dev-{name}-{id}.your-domain.com` URL with streaming logs

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
