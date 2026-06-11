# Getting Started

Atelier gives you **isolated, VM-grade dev environments that boot in seconds**, self-hosted on your own Kubernetes cluster. One Helm install, and every developer (or AI agent) gets a full sandbox — VS Code, an AI coding agent, and a browser — accessible from any device.

## The Pitch

- **Spawn a sandbox in seconds** — copy-on-write snapshots clone a fully prepared environment (repo cloned, deps installed, build warm) in under a second
- **Real VM isolation** — Kata Containers run each sandbox in its own lightweight VM, not just a container namespace
- **Batteries included** — every sandbox ships with [code-server](https://github.com/coder/code-server) (VS Code in the browser), [OpenCode](https://github.com/anomalyco/opencode) (AI coding agent), Chromium via KasmVNC, and access to a multi-provider AI proxy
- **Work from anywhere** — push a task to OpenCode from the dashboard, close your laptop, review the result from your phone
- **Self-hosted & simple** — one bare-metal server, k3s, and a single Helm chart. No SaaS, no per-seat pricing, your code never leaves your infrastructure

## How Easy Is It to Use?

Once deployed, daily usage is entirely dashboard-driven:

1. **Define a workspace** — point it at your git repos, set init commands (`bun install`, `npm run build`, …), dev commands, ports, and secrets
2. **(Optional) Run a prebuild** — Atelier runs the expensive setup once and snapshots the result
3. **Spawn sandboxes** — each one clones from the snapshot instantly. Open VS Code in your browser, or SSH in with your usual tooling (`ssh sandbox-{id}@your-host -p 2222`)
4. **Dispatch AI tasks** — create a coding task from the dashboard; Atelier spawns a sandbox, creates a branch, launches OpenCode with your prompt, and tracks progress
5. **Preview with auto-HTTPS** — dev commands get a public `https://dev-{name}-{id}.your-domain.com` URL with streaming logs

No local setup is required for users beyond a browser (or an SSH client).

## How Easy Is It to Install?

The whole stack installs onto a single server in about 15 minutes:

```bash
# 1. k3s (Kubernetes)
curl -sfL https://get.k3s.io | sh -

# 2. Helm
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# 3. cert-manager (automatic TLS)
helm repo add jetstack https://charts.jetstack.io
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace --set crds.enabled=true

# 4. Kata Containers (VM isolation)
git clone --depth 1 https://github.com/kata-containers/kata-containers.git /tmp/kata-src
helm install kata-deploy /tmp/kata-src/tools/packaging/kata-deploy/helm-chart/kata-deploy \
  --set k8sDistribution=k3s \
  --set env.createRuntimeClasses=true \
  --set env.createDefaultRuntimeClass=true

# 5. Atelier
helm install atelier charts/atelier/ \
  --namespace atelier-system --create-namespace \
  --values values.production.yaml
```

A minimal `values.production.yaml` needs only your domain, a GitHub OAuth app, and a Cloudflare API token for wildcard TLS:

```yaml
domain:
  baseDomain: "example.com"
  tls:
    email: "admin@example.com"

auth:
  github:
    clientId: "your-github-client-id"
    clientSecret: "your-github-client-secret"

certManager:
  cloudflare:
    apiToken: "your-cloudflare-api-token"
```

Full step-by-step instructions (including optional TopoLVM for prebuilds): [Setup Guide](setup.md).

## Requirements

### Hardware

| Requirement | Detail |
|-------------|--------|
| CPU | x86_64 with VT-x / AMD-V enabled |
| Virtualization | Bare-metal KVM — `/dev/kvm` must be present |
| RAM | 8 GB minimum (16–64 GB recommended depending on sandbox count) |
| Storage | 40 GB minimum; NVMe + LVM thin pool recommended for prebuilds |
| OS | Debian 12 / Ubuntu 22.04+ (apt-based, systemd) |

> Kata Containers needs hardware virtualization. Most cloud VMs don't expose `/dev/kvm` — a **bare-metal server is the recommended target**. See [Recommended Infrastructure](recommended-infrastructure.md).

### Software (installed during setup)

| Dependency | Purpose |
|------------|---------|
| [k3s](https://k3s.io) | Lightweight Kubernetes distribution |
| [Helm](https://helm.sh) | Chart-based deployment |
| [cert-manager](https://cert-manager.io) | Automated TLS certificates |
| [kata-deploy](https://github.com/kata-containers/kata-containers) | Kata Containers runtime (Cloud Hypervisor) |
| TopoLVM *(optional)* | CSI snapshots — required for prebuilds / instant cloning |

### Networking

- A domain with **wildcard DNS** (`*.your-domain.com` → server IP)
- Ports `80` / `443` open (HTTPS), port `2222` open (SSH proxy)
- A Cloudflare-managed DNS zone (currently the only supported DNS-01 solver for wildcard certificates)

## Try It Without a Server

The manager runs in mock mode on any machine — no KVM, no Kubernetes:

```bash
bun install
ATELIER_SERVER_MODE=mock bun run dev
# API:       http://localhost:4000
# Swagger:   http://localhost:4000/swagger
# Dashboard: http://localhost:5173
```

## Next Steps

- [Setup Guide](setup.md) — full installation walkthrough and troubleshooting
- [Recommended Infrastructure](recommended-infrastructure.md) — what server to rent and how to size it
- [Advanced Configuration](advanced-configuration.md) — every Helm option explained
- [Architecture](architecture.md) — how it all fits together
