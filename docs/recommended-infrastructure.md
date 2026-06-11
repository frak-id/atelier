# Recommended Infrastructure

Atelier needs **bare metal with KVM**. Kata Containers boots a real lightweight VM per sandbox, so the host must expose `/dev/kvm`. Most cloud VMs (AWS EC2, GCP, standard Hetzner Cloud instances) don't support nested virtualization reliably — rent a dedicated server instead.

## TL;DR

A single **Hetzner dedicated server (AX-line)** running k3s is the sweet spot: cheap, NVMe-backed, KVM-capable, and more than enough for a small team.

## Sizing Guide

Each sandbox is a VM with its own kernel, plus the workloads inside it (code-server, OpenCode, Chromium, your dev servers). Budget roughly **2–4 GB RAM and 1–2 vCPU per active sandbox**, plus ~4 GB for the system (k3s, manager, Zot, CLIProxy, sshpiper).

| Team size | Concurrent sandboxes | RAM | CPU | Storage |
|-----------|---------------------|-----|-----|---------|
| Solo / trying it out | 2–4 | 16 GB | 4–6 cores | 250 GB NVMe |
| Small team | 5–10 | 64 GB | 8 cores / 16 threads | 512 GB – 1 TB NVMe |
| Larger team | 15–20+ | 128 GB | 16 cores / 32 threads | 2 × 1 TB NVMe |

## Example: Hetzner Dedicated Servers

| Server | Specs (typical) | Good for |
|--------|-----------------|----------|
| **AX42** | Ryzen 7 PRO 8700GE, 64 GB DDR5, 2 × 512 GB NVMe | Solo dev / small team — recommended starting point |
| **AX52** | Ryzen 7 7700, 64 GB DDR5, 2 × 1 TB NVMe | Small team with heavy prebuilds |
| **AX102** | Ryzen 9 7950X3D, 128 GB DDR5, 2 × 1.92 TB NVMe | 15–20 concurrent sandboxes |

Other bare-metal providers work equally well (OVH, Scaleway Elastic Metal, a homelab box) — the only hard requirements are x86_64, KVM, and an apt-based distro (Debian 12 / Ubuntu 22.04+).

> **Tip:** Hetzner Server Auction often has comparable hardware at lower monthly prices with no setup fee.

## Recommended Stack

```
Bare-metal server (Debian 12)
└── k3s (single node, built-in Traefik ingress)
    ├── kata-deploy        → Kata Containers runtime (Cloud Hypervisor)
    ├── cert-manager       → wildcard TLS via Cloudflare DNS-01
    ├── TopoLVM            → LVM thin-provisioned PVCs + CSI snapshots
    └── Atelier Helm chart → manager, dashboard, Zot, CLIProxy, sshpiper
```

### Why single-node k3s?

- One server keeps operations trivial: one kubeconfig, one Helm release, one thing to back up
- TopoLVM snapshots are node-local — instant copy-on-write cloning works best when all sandboxes share the node's LVM thin pool
- Vertical scaling (a bigger Hetzner box) goes a long way before multi-node is worth the complexity

### Disk layout for prebuilds (TopoLVM)

Prebuilds and instant cloning need an **LVM thin pool**. When provisioning the server, leave the second NVMe drive (or a large partition) unformatted, then:

```bash
# Create a volume group + thin pool on the spare disk
pvcreate /dev/nvme1n1
vgcreate atelier-vg /dev/nvme1n1
lvcreate -l 95%FREE --thinpool pool0 atelier-vg
```

Then install TopoLVM pointing `device-classes` at `atelier-vg` (see [Setup Guide](setup.md#4-storage-and-snapshots-optional)). Without this, Atelier still works — prebuilds are just disabled automatically.

## DNS & Networking

- Put your domain on **Cloudflare** (currently the only supported DNS-01 solver for the wildcard certificate)
- Create records: `your-domain.com` → server IP, `*.your-domain.com` → server IP
- Open inbound ports: `80`, `443` (Traefik), `2222` (sshpiper NodePort, mapped from `30022` or via firewall DNAT)
- Recommended hardening on Hetzner: use the Robot firewall to restrict everything else; consider allow-listing port `6443` (k3s API) to your own IP

## Cost Ballpark

| Item | Monthly cost (approx.) |
|------|------------------------|
| Hetzner AX42 | ~€46 |
| Domain | ~€1 |
| Cloudflare DNS | free |
| **Total** | **~€50/month** for a full self-hosted cloud-dev platform |

Compare with per-seat SaaS dev-environment pricing and the math usually works out after the first one or two users.

## Backups

The state that matters:

- **Manager SQLite database** — PVC `atelier-manager` in `atelier-system` (workspaces, tasks, settings)
- **Zot registry** — base images (rebuildable from Dockerfiles, but backups save time)
- **Your values file + secrets** — keep `values.production.yaml` in a private repo or vault

Sandboxes themselves are disposable by design — anything important should live in git.
