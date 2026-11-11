# Atelier

Self-hosted micro-VM sandboxes for coding agents. Each sandbox is a
Kata Containers VM on Kubernetes (or a Docker container in local mode) with
a repo checked out, an agent harness, and optional tools such as code-server
and a browser. You drive sandboxes from the web console, and agents drive them
over MCP.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

## What it does

- **Sandboxes.** Spawn an isolated environment from a repo, a prebuild or a
  snapshot. Pause, resume, snapshot, fork and destroy it. Idle sandboxes pause
  on their own, and a paused sandbox wakes when you open its URL, connect over
  SSH or run an operation on it.
- **Prebuilds.** Clone, install and build once, snapshot the volume, and boot
  every later sandbox from a copy-on-write clone. A prebuild is keyed on the
  base image and each repo's HEAD, so a push rebuilds it.
- **Agent tasks.** Hand a prompt to the coding agent inside a sandbox
  (OpenCode or pi, over [ACP](https://agentclientprotocol.com)) and collect
  the result later. Agents approve their own permission requests: the VM is the
  boundary. Each task keeps its git result (branch, head, commits ahead, diff
  stat) and survives a server restart.
- **Task inbox.** The console home lists tasks that need review, are running
  or failed, across all sandboxes, with a nav badge and optional browser
  notifications.
- **Toolboxes.** Org-owned recipes (build steps, paths, processes, ports,
  files) compiled into versioned toolset artifacts that every spawn mounts. A
  toolbox can auto-inject into every sandbox of its org. The base images ship
  no coding agent: the console's Library suggests starter toolboxes (opencode,
  pi with CLIProxyAPI, code-server).
- **Access.** A browser terminal, SSH through the server's own gateway, and
  public HTTPS URLs per port behind forward-auth.

## MCP

Agents connect with `Authorization: Bearer <API key or token>` to two
endpoints. Tool names and order are pinned by
`apps/server/src/api/mcp/tools/surface.test.ts`. An agent shared by several
people should use a [service account](docs/service-accounts.md): its own key,
sandboxes and GitHub credential instead of a person's.

### `/mcp`: sandbox tools (13)

| Tool | Purpose |
|------|---------|
| `whoami` | The caller, orgs, default image, available toolboxes and recent prebuilds |
| `get_sandbox` | Read one sandbox or list them; can wait for a status |
| `create_sandbox` | Start a sandbox; returns the id and a job at once |
| `sandbox_lifecycle` | `pause`, `resume`, `snapshot`, `fork`, `keep_awake` |
| `destroy_sandbox` | Delete a sandbox |
| `exec` | Run a command; output is capped, head and tail |
| `read_files` | Read files (text, line ranges, size cap) |
| `write_files` | Write files with mode and owner |
| `manage_process` | Start, stop, restart and read logs of a sandbox process |
| `expose_port` | Publish a port as a URL, behind forward-auth by default |
| `send_prompt` | Start an agent task, or add a turn to one |
| `get_task` | Read one task or list tasks; can wait for a result |
| `manage_task` | Cancel or close a task |

### `/mcp/admin`: admin tools (4)

Server admins only (owners of the default org). Anyone else gets 403.

| Tool | Purpose |
|------|---------|
| `manage_prebuilds` | List, create, refresh, delete prebuilds |
| `manage_toolbox` | List, create, update, delete, capture, refresh, pin and publish versions, transfer |
| `manage_images` | List images and seeds, rebuild a seed, read build logs |
| `server_config` | List, read and set the operational config keys |

Tools return structured results with behaviour annotations. An unknown
session id answers 404, so clients re-initialize after a deploy.

## Quickstart: local mode

Local mode runs the server and console against your Docker daemon. Auth is
bypassed, there is no GitHub app and no cluster. Sandboxes are Docker
containers, not VMs.

It needs Linux or OrbStack: the compose file uses host networking, and Docker
Desktop's "host" is its VM, so the server cannot reach published sandbox
ports there.

```bash
GITHUB_TOKEN=$(gh auth token) docker compose -f docker-compose.local.yml up
```

`GITHUB_TOKEN` is optional and lets sandboxes clone private repos. Open
<http://127.0.0.1:8080> for the console. The API listens on port 4000. Set
`ATELIER_TAG=nightly` to run nightly images. Wipe state with
`docker compose -f docker-compose.local.yml down -v`.

The default image is the published `dev-base`, which Docker pulls on the
first spawn. Open Spawn in the console, pick a repo and start.

## Quickstart: cluster

Production runs on k3s with Kata Containers (bare metal with `/dev/kvm`),
TopoLVM snapshots, an OCI registry and BuildKit. Atelier deploys only the
server and console, from `infra/k8s`, and references the rest by name.
[docs/setup.md](docs/setup.md) covers prerequisites, install and
[upgrading](docs/setup.md#upgrading-to-this-release).
[infra/k8s/README.md](infra/k8s/README.md) has the apply sequence and
`deploy.sh`.

## Architecture

```
console (React SPA) ─┐
MCP clients ─────────┼──► server (Bun/Elysia) ──► Kubernetes + Kata, or Docker
SSH clients ─────────┘         │                        │
                               └── SQLite         sandbox (micro-VM)
                                                   ├─ atelier-agent (Rust)
                                                   ├─ your processes
                                                   └─ toolset overlays
```

- **Server** (`apps/server`): `runtime/` (sandbox mechanism), `control/`
  (identity, orgs, secrets, toolboxes), `sessions/` (ACP agent tasks), `api/`
  (HTTP, MCP, application layer).
- **Agent** (`apps/agent`): a static Rust binary in each sandbox. Process
  supervision, files, exec, terminal and ACP relay, all behind a bearer token.
- **Console** (`apps/console`): React 19 SPA.
- **Contract** (`packages/spec`): `SandboxSpec` and the shared wire types.

A sandbox is `files + processes + ports`. The runtime does not know what a
harness is. See [docs/architecture.md](docs/architecture.md).

## Develop

```bash
bun install
bun run --filter @atelier/server dev   # local mode, Docker backend, :4000
bun run --filter @atelier/console dev  # console on :5174, proxies to :4000
```

The server dev script needs a running Docker daemon. See
[AGENTS.md](AGENTS.md) for layout, commands and conventions.

## Documentation

- [Setup](docs/setup.md): cluster install, upgrading, backups, troubleshooting
- [Advanced configuration](docs/advanced-configuration.md): config keys and env vars
- [Architecture](docs/architecture.md): components, flows, API surface
- [Idle auto-pause](docs/idle-autopause.md) and auto-resume
- [Toolbox versions](docs/toolbox-versions.md): versions, pins, refresh, transfer
- [Constraints](docs/constraints.md): gotchas
- [Code patterns](docs/patterns.md): conventions for contributors
- [Roadmap](docs/roadmap.md): remaining gaps

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## License

[MIT](LICENSE.md)
