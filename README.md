# Atelier

Isolated dev environments that boot in seconds, not minutes.

**Self-hosted Kata Containers sandboxes with K8s orchestration.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.md)

![demo](https://raw.githubusercontent.com/frak-id/atelier/main/docs/assets/demo.gif)

## Batteries Included

Each sandbox is a complete development environment — VS Code, AI agent, and browser, accessible from any device.

- **[code-server](https://github.com/coder/code-server)** — VS Code in the browser, zero local setup
- **[OpenCode](https://github.com/anomalyco/opencode)** — AI coding agent, launch tasks and review results from anywhere
- **Chromium via [KasmVNC](https://kasmweb.com/kasmvnc)** — full browser inside your sandbox for previewing, testing, debugging
- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** — multi-provider AI model proxy (Claude, Gemini, Codex) with management UI

Spawn a sandbox, push a task to OpenCode, close your laptop.
Review the results from your phone on the ski lift — or wherever you happen to be.

## Features

- **Task dispatch** — create coding tasks from the console. Atelier spawns a sandbox, creates a git branch, launches OpenCode with your prompt, and tracks progress. An AI task queue for your team
- **Session templates** — 4 built-in AI workflows (Implementation, Best Practices Review, Security Review, Simplification) with customizable models, effort levels, and prompt templates per workspace
- **Console** — mission control for all your sandboxes: real-time task progress, running dev servers, and an attention feed aggregating OpenCode permission and question requests across every session
- **Prebuilds** — run expensive setup (git clone, dependency install, build) once and snapshot it. Subsequent sandboxes clone from the snapshot instantly via copy-on-write
- **Dev server with auto HTTPS** — define a dev command in your workspace config (e.g. `npm run dev`) and get a public `https://dev-{id}.your-domain.com` URL with streaming logs
- **Two base images out of the box** — `dev-base` ships with Node 22 and Bun; `dev-cloud` extends it with AWS CLI, Google Cloud SDK, kubectl, and Pulumi
- **Workspace definitions** — configure git repos to clone, init commands, a dev server, exposed ports, secrets, and resource limits per workspace
- **OpenCode config replication** — define OpenCode configuration globally or per workspace, automatically replicated to every sandbox
- **Auth synchronization** — OAuth tokens are synced across all running sandboxes so you authenticate once and every instance just works
- **Custom npm registry** — point sandboxes at your own npm proxy (Verdaccio, Nexus, Artifactory, …) with a single `npmRegistryUrl` setting; npm/bun/yarn configs are injected automatically. Leave it empty to use the public registry
- **SSH access** — use your regular workflow: SSH, VS Code Remote SSH, JetBrains remote. [sshpiper](https://github.com/tg123/sshpiper) provides username-based routing so `ssh sandbox-{id}@host -p 2222` just works
- **MCP server** — AI agents can orchestrate sandboxes, tasks, workspaces, and dev servers programmatically via the Model Context Protocol
- **GitHub App integration** — connect your GitHub account for repository discovery and branch listing
- **Multi-dev per sandbox** — nothing stops multiple developers from working in the same sandbox simultaneously
- **Config file sync** — manage global and per-workspace config files, automatically synced to sandboxes

## Why Atelier?

Atelier runs isolated development sandboxes on Kubernetes with Kata Containers.

- **VM isolation** — each sandbox is a real virtual machine, not a container namespace
- **Instant cloning** — CSI VolumeSnapshots via TopoLVM clone a full environment in under a second via copy-on-write
- **Prebuilds** — run expensive setup once, snapshot the filesystem, spawn instantly from there
- **Simple operations** — Kubernetes-native workflows with Helm deployment

## Requirements

### Hardware

- x86_64 CPU with virtualization enabled
- Bare-metal server with KVM (`/dev/kvm` present)
- apt-based Linux distro (Debian, Ubuntu) with systemd

### Software

| Dependency | Purpose |
|------------|---------|
| **[k3s](https://k3s.io)** | Lightweight Kubernetes distribution |
| **[Helm](https://helm.sh)** | Chart-based deployment |
| **[cert-manager](https://cert-manager.io)** | Automated TLS certificates |
| **[kata-deploy](https://github.com/kata-containers/kata-containers)** | Kata Containers runtime (Cloud Hypervisor) |
| **Docker** | Building server, console, and agent images |
| **TopoLVM** *(optional)* | CSI driver for PVC snapshots — required for prebuilds |

### Networking

- A domain with wildcard DNS (`*.your-domain.com` → server IP)
- Ports `80` and `443` open for HTTPS
- Port `2222` open for SSH proxy access

## Quickstart

### 1. Install prerequisites on your server

```bash
# k3s
curl -sfL https://get.k3s.io | sh -

# Helm
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# cert-manager
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace --set crds.enabled=true

# Kata Containers
git clone --depth 1 https://github.com/kata-containers/kata-containers.git /tmp/kata-src
helm install kata-deploy /tmp/kata-src/tools/packaging/kata-deploy/helm-chart/kata-deploy \
  --set k8sDistribution=k3s \
  --set env.createRuntimeClasses=true \
  --set env.createDefaultRuntimeClass=true
```

### 2. Create a values file

```yaml
# values.production.yaml
domain:
  baseDomain: "example.com"
  tls:
    email: "admin@example.com"

auth:
  github:
    clientId: "your-github-client-id"
    clientSecret: "your-github-client-secret"
  allowedOrg: "your-github-org"  # optional

certManager:
  enabled: true
  cloudflare:
    apiToken: "your-cloudflare-api-token"
```

Set the Authorization callback URL in your GitHub OAuth App to `https://sandbox.example.com/auth/callback`.

### 3. Deploy the shared infra chart

```bash
helm install atelier charts/atelier/ \
  --namespace atelier-system --create-namespace \
  --values values.production.yaml
```

Or use the deploy script (builds the agent image, pushes to GHCR, deploys the chart via SSH):

```bash
VALUES_FILE=./values.production.yaml ./scripts/deploy-k8s.sh
```

This chart provisions cluster-wide infra only — Zot, CLIProxyAPI, sshpiper,
cert-manager issuers, the Kata `RuntimeClass`, and the prebuild
`VolumeSnapshotClass`. It does not deploy the server or console app.

### 4. Deploy the server + console app

The app itself (server + console, one pod) is deployed with plain manifests
under `infra/k8s/v2/`, which point at the infra chart's Zot/CLIProxy/etc. See
[`infra/k8s/v2/README.md`](infra/k8s/v2/README.md) for the full apply
sequence (namespaces → RBAC → kata custom runtime → config → PVC → secret →
deployment → service → ingress).

### 5. Verify

```bash
kubectl -n atelier-v2-system get pods
kubectl -n atelier-v2-system logs -f deploy/atelier-v2 -c server
```

Your console is at the `domain.dashboard` you configured in
`infra/k8s/v2/30-config.yaml`.

## Helm Chart Overview

`charts/atelier` deploys shared cluster infra — not the app itself:

| Component | Purpose |
|-----------|---------|
| **Zot** | Lightweight OCI registry for base images |
| **CLIProxyAPI** | AI model proxy with multi-provider OAuth |
| **sshpiper** | SSH proxy with username-based routing to sandboxes |
| **cert-manager issuers** | ClusterIssuer + wildcard TLS certs |
| **Kata RuntimeClass** | VM isolation runtime for sandbox pods |

The server + console app is deployed separately via `infra/k8s/v2/` (see
above). Sandbox pods are created dynamically in the namespace configured by
`kubernetes.namespace` in the app's config, using the Kata runtime class.

### Key configuration

```yaml
# charts/atelier/values.yaml (shared infra)
zot:
  enabled: true
  persistence:
    size: 20Gi

cliproxy:
  enabled: true

sshpiper:
  enabled: true
  nodePort: 30022          # external SSH port

certManager:
  enabled: true
  cloudflare:
    apiToken: ""
```

See [`charts/atelier/values.yaml`](charts/atelier/values.yaml) for all infra
options, and [Advanced Configuration](docs/advanced-configuration.md) for the
app's domain/auth/server/kubernetes/sandbox settings (set via
`infra/k8s/v2/30-config.yaml` + the `atelier-v2-secrets` Secret).

## Local Development

No server or KVM needed — the server runs in mock mode:

```bash
bun install
bun run --filter @atelier/server dev   # API:     http://localhost:4000
                                        # Swagger: http://localhost:4000/swagger
bun run --filter @atelier/console dev  # Console: http://localhost:5174
```

## Documentation

- [Getting Started](docs/getting-started.md) — what Atelier is, why it's easy, and how to try it
- [Setup Guide](docs/setup.md) — installation and configuration
- [Recommended Infrastructure](docs/recommended-infrastructure.md) — server sizing, Hetzner + k3s recommendations, cost ballpark
- [Advanced Configuration](docs/advanced-configuration.md) — full reference for every Helm option
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
