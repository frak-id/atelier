# Getting Started

Atelier gives you **isolated, VM-grade dev environments that boot in seconds**, self-hosted on your own Kubernetes cluster. One deploy, and every developer (or AI agent) gets a full sandbox — VS Code, an AI coding agent, and an optional browser desktop — accessible from any device.

## The Pitch

- **Spawn a sandbox in seconds** — copy-on-write snapshots clone a fully prepared environment (repo cloned, deps installed, build warm) in under a second
- **Real VM isolation** — Kata Containers run each sandbox in its own lightweight VM, not just a container namespace
- **Batteries included** — every sandbox ships with [code-server](https://github.com/coder/code-server) (VS Code in the browser), [OpenCode](https://github.com/anomalyco/opencode) (AI coding agent), and access to a multi-provider AI proxy; an in-sandbox Chromium desktop (KasmVNC) is opt-in via the `dev-browser` base / `browser` toolbox
- **Work from anywhere** — push a task to OpenCode from the console, close your laptop, review the result from your phone
- **Self-hosted & simple** — one bare-metal server, k3s, and a handful of manifests. No SaaS, no per-seat pricing, your code never leaves your infrastructure

## How Easy Is It to Use?

Once deployed, daily usage is entirely console-driven:

1. **Define a workspace** — point it at your git repos, set init commands (`bun install`, `npm run build`, …), dev commands, ports, and secrets
2. **(Optional) Run a prebuild** — Atelier runs the expensive setup once and snapshots the result
3. **Spawn sandboxes** — each one clones from the snapshot instantly. Open VS Code in your browser, or SSH in with your usual tooling (`ssh sandbox-{id}@your-host -p 2222`)
4. **Dispatch AI tasks** — create a coding task from the console; Atelier spawns a sandbox, creates a branch, launches OpenCode with your prompt, and tracks progress
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

# 4. Kata Containers (VM isolation) + the atelier custom runtime
#    (kata-atelier-clh-rs: runtime-rs Cloud Hypervisor, block passthrough for
#    the workspace volume; see docs/setup.md for the two node settings)
helm install kata-deploy \
  oci://ghcr.io/kata-containers/kata-deploy-charts/kata-deploy \
  -n default -f infra/k8s/v2/kata-atelier-values.yaml

# 5. Cluster infra atelier references by name (not bundled): a ClusterIssuer,
#    TopoLVM + a VolumeSnapshotClass, an OCI registry (e.g. Zot) and BuildKit

# 6. Atelier server + console app — see infra/k8s/v2/README.md
```

The app config (`infra/k8s/v2/30-config.yaml`) needs your domain, the names of
those cluster resources, and a Secret with your GitHub OAuth app.

Full step-by-step instructions: [Setup Guide](setup.md).

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
| [Helm](https://helm.sh) | Installs the cluster dependencies below |
| [cert-manager](https://cert-manager.io) | Automated TLS certificates |
| [kata-deploy](https://github.com/kata-containers/kata-containers) | Kata Containers runtime (Cloud Hypervisor) |
| TopoLVM *(optional)* | CSI snapshots — required for prebuilds / instant cloning |

### Networking

- A domain with **wildcard DNS** (`*.your-domain.com` → server IP)
- Ports `80` / `443` open (HTTP-01 challenges + HTTPS), and the SSH NodePort (`30222` by default)

## Try It Without a Server

The server runs in mock mode on any machine — no KVM, no Kubernetes:

```bash
bun install
bun run --filter @atelier/server dev   # API:     http://localhost:4000
                                        # Swagger: http://localhost:4000/swagger
bun run --filter @atelier/console dev  # Console: http://localhost:5174
```

## Next Steps

- [Setup Guide](setup.md) — full installation walkthrough and troubleshooting
- [Recommended Infrastructure](recommended-infrastructure.md) — what server to rent and how to size it
- [Advanced Configuration](advanced-configuration.md) — server configuration explained
- [Architecture](architecture.md) — how it all fits together
