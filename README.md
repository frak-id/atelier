# Atelier

**Self-hosted VM sandboxes for AI coding agents — and the humans who supervise them.**

Spawn an isolated dev environment in seconds, drive the AI agent inside it from
a web console or your terminal, approve its permission requests from any device,
and throw the whole thing away when you're done. Every sandbox is a real virtual
machine (Kata Containers), not a container namespace.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

<!-- TODO(screenshot): hero — console fleet view with live agent sessions across sandboxes -->
> 📸 _Screenshot placeholder — **fleet view**: every sandbox and its live agent sessions, at a glance_

## Why Atelier?

AI coding agents want to run commands, install packages, and touch the network.
Giving them your laptop is scary; giving them a shared container is not much
better. Atelier gives each agent (and each experiment, branch, or teammate) a
**disposable micro-VM** with hardware-level isolation — cloned from a snapshot
in under a second.

- **VM isolation, container ergonomics** — Kata Containers micro-VMs, orchestrated as plain Kubernetes pods
- **Boot in seconds** — prebuilds run your expensive setup (clone, install, build) once; every sandbox after that is a copy-on-write clone
- **Agent mission control** — start agent sessions, stream output, and answer a cross-sandbox **attention feed** of permission and question requests. Close your laptop; review from your phone
- **Harness-agnostic** — agents talk [ACP](https://agentclientprotocol.com). [OpenCode](https://github.com/anomalyco/opencode) and **pi** ship today; adding another harness is a client-side composer, not a runtime change
- **Agents can orchestrate it too** — a built-in **MCP server** lets any AI agent spawn, exec, snapshot, and destroy sandboxes programmatically
- **Nothing hardcoded** — a sandbox is just `files + processes + ports` described by a declarative `SandboxSpec`. The runtime has no idea what a "harness" or an "editor" is

<!-- TODO(screenshot): agent session with a pending permission request (Allow once / Always / Reject) -->
> 📸 _Screenshot placeholder — **attention feed**: approve or reject an agent's permission request, with risk labels_

## Batteries Included

Each sandbox is composed from modular pieces, assembled from your org's
toolboxes and saved specs:

- **AI coding harness** — OpenCode (default) or pi, driven over ACP
- **[code-server](https://github.com/coder/code-server)** — VS Code in the browser, zero local setup
- **Chromium via [KasmVNC](https://kasmweb.com/kasmvnc)** — a full browser inside the sandbox for previewing and debugging
- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** — multi-provider AI model proxy (Claude, Gemini, Codex); authenticate once, every sandbox inherits it
- **Public HTTPS for any port** — declare a port, get `https://{name}-{id}.your-domain.com` behind forward-auth
- **SSH that just works** — `ssh sandbox-{id}@host -p 2222`, VS Code Remote SSH, JetBrains remote

## Quickstart

Two ways to run Atelier, depending on what you have.

### Path 1 — You have a Kubernetes cluster

Install the Helm chart with a minimal values file; everything else is
configured from the console on first connection, or via the CLI.

```bash
helm install atelier oci://ghcr.io/frak-id/charts/atelier \
  --namespace atelier-system --create-namespace \
  --set domain.baseDomain=example.com \
  --set domain.tls.email=admin@example.com \
  --set auth.github.clientId=<client-id> \
  --set auth.github.clientSecret=<client-secret>
```

Then open `https://sandbox.example.com`, sign in with GitHub, and spawn your
first sandbox.

Full isolation (Kata micro-VMs) requires nodes with KVM (`/dev/kvm`) and the
[kata-deploy](https://github.com/kata-containers/kata-containers) runtime;
instant cloning requires a CSI driver with VolumeSnapshot support (we recommend
[TopoLVM](https://github.com/topolvm/topolvm)). See the
[Setup Guide](docs/setup.md) for prerequisites, DNS/TLS options, and the
GitHub OAuth app.

> ⚠️ The single-chart install is being consolidated — today the chart deploys
> the shared infra and the app is applied separately; see the
> [Setup Guide](docs/setup.md) for the current sequence and the
> [roadmap](docs/roadmap.md) for progress.

### Path 2 — No cluster? Local mode

Run sandboxes on your own machine with Docker — no Kubernetes, no bare metal,
no domain. The server ships a Docker backend (`ATELIER_RUNTIME_BACKEND=docker`)
that runs each sandbox as a local container with the same agent, specs, and
session machinery as the cluster path:

```bash
npm install -g @konfeature/atelier

atelier local up        # start a local server against your Docker daemon
atelier up              # spawn your first sandbox
```

Local mode trades VM isolation for convenience (sandboxes are Docker
containers), but the product — specs, agent sessions, the console, the CLI
cockpit — works the same. Perfect for evaluating Atelier before committing a
server to it.

> ⚠️ The `atelier local` one-liner is under active development; today local
> mode means running the server yourself with the Docker backend. See the
> [roadmap](docs/roadmap.md).

<!-- TODO(screenshot/gif): CLI cockpit — `atelier` interactive browse + live boot log stream -->
> 📸 _Screenshot placeholder — **CLI cockpit**: spawn a sandbox and watch the VM boot live from your terminal_

## Features

### For working with agents

- **Agent sessions** — drive the in-sandbox agent from console or CLI: start sessions, stream output, review todos, attach to any process read-write or read-only
- **Attention feed** — permission and question requests from every sandbox aggregated in one place, with risk categorization
- **MCP server** — 14 tools for sandbox lifecycle, exec, file patching, port exposure, prebuilds, and toolbox management; per-user authenticated sessions
- **Pluggable harnesses** — the available harness set is derived at runtime from `@atelier/compose` composers, so a pi-first or opencode-first org sees its own stack everywhere

### For fast, reproducible environments

- **Prebuilds** — content-addressed snapshots keyed on the base image *and* each repo's remote HEAD; a `git push` busts the cache automatically. Prebuilds can chain on other prebuilds
- **Toolboxes & toolsets** — user- or org-scoped recipes (`build[]` + `paths[]`) compiled once into versioned, content-addressed artifacts and mounted into every spawn as squashfs overlays. Add any binary or tool without rebuilding a base image
- **Saved specs** — name a `SandboxSpec` once, spawn it one-tap later, scoped to you or your org
- **Pause / resume** — snapshot a sandbox and release its compute; resume later with fresh git credentials rotated in
- **Three base images** — `dev-base` (Node 22 + Bun), `dev-cloud` (+ AWS/GCP/kubectl/Pulumi), `dev-rust` (+ Rust toolchain)

### For teams and operators

- **Org policy injection** — mandate spec fragments (audit processes, compliance files, required env) server-side on every spawn, regardless of who or what created the sandbox
- **Secrets store** — `{"$secret": "NAME"}` references in any spec field, resolved server-side, never stored in the runtime DB
- **GitHub OAuth** — sign in with GitHub, optionally gated to an org, with repository/branch discovery
- **Multi-dev per sandbox** — nothing stops multiple developers (or one dev + one agent) sharing a sandbox
- **Custom npm registry** — point every sandbox at your Verdaccio/Nexus/Artifactory proxy with one setting
- **Config file sync** — global and per-scope config files, automatically synced into sandboxes

### The seam that keeps it simple

A sandbox is `files + processes + ports` — nothing more. `@atelier/spec`
defines the contract; `@atelier/compose` builds specs client-side from harness
and preset fragments (`vscode`, `browser`, `terminal`). The runtime never
learns what a "harness" is, so extending Atelier means composing specs, not
patching the server.

## The CLI

The `atelier` binary is a full cockpit, not just a client:

```bash
atelier                 # interactive cockpit: pick a sandbox, act on it
atelier up --bake --spec spec.jsonc   # spec → prebuild → sandbox, one command
atelier ps              # list sandboxes
atelier exec <id> -- bun test
atelier ssh <id>        # SSH shell (keys auto-registered on first setup)
atelier attach <id> opencode          # attach to the agent process, Ctrl-] detaches
atelier pause <id> / resume <id> / snapshot <id>
```

Every command takes `--json` for scripting.

## Architecture at a Glance

```
console (React SPA) ─┐
atelier CLI ─────────┼──► server (Bun/Elysia) ──► Kubernetes + Kata Containers
MCP clients ─────────┘         │                        │
                               │                   sandbox pod (micro-VM)
                               └── SQLite            ├─ atelier-agent (Rust)
                                                     ├─ your processes
                                                     └─ squashfs toolset overlays
```

- **Server** — runtime orchestration, control plane (auth/orgs/secrets), ACP session bridge, MCP server, observable job queue (SSE)
- **Agent** — a static Rust binary inside each sandbox: process supervision, file sync, PTY multiplexing, ACP relay
- **Backends** — Kubernetes (Kata micro-VMs, VolumeSnapshot cloning) or Docker (local mode)

See [Architecture](docs/architecture.md) for the full picture.

## Local Development

The server runs in mock mode — no Kubernetes, no Docker, no KVM:

```bash
bun install
bun run --filter @atelier/server dev   # API:     http://localhost:4000
                                       # Swagger: http://localhost:4000/swagger
bun run --filter @atelier/console dev  # Console: http://localhost:5174
```

The repo is a Bun monorepo: `@atelier/server` (Bun/Elysia) and
`@atelier/console` (React 19 / TanStack Router) apps, the in-pod
`atelier-agent` (Rust, `apps/agent-v2`), the `atelier` host CLI (`apps/cli`),
and the `@atelier/spec` / `@atelier/compose` / `@atelier/shared` packages.
See [`AGENTS.md`](AGENTS.md) for the full layout.

## Documentation

- [Getting Started](docs/getting-started.md) — what Atelier is and how to try it
- [Setup Guide](docs/setup.md) — installation and configuration
- [Recommended Infrastructure](docs/recommended-infrastructure.md) — server sizing, Hetzner + k3s recommendations, cost ballpark
- [Advanced Configuration](docs/advanced-configuration.md) — full configuration reference
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
