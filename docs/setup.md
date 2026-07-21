# Setup

Atelier runs on a bare-metal Kubernetes cluster using k3s and Kata Containers. This guide covers the full installation, from a fresh server to a working console.

New to Atelier? Read [Getting Started](getting-started.md) first. Choosing hardware? See [Recommended Infrastructure](recommended-infrastructure.md).

## Requirements

### Hardware
- Bare-metal server (KVM virtualization is required — `/dev/kvm` must exist).
- x86_64 CPU with VT-x or AMD-V enabled.
- Minimum 8 GB RAM and 40 GB storage (see [sizing guide](recommended-infrastructure.md#sizing-guide)).

### Software
- Debian 12 (Bookworm) or Ubuntu 22.04+ with systemd.

### Networking
- A domain with wildcard DNS support, managed on **Cloudflare** (currently the only supported DNS-01 solver for wildcard certificates).
- `your-domain.com` and `*.your-domain.com` pointing to the server IP.
- Open inbound ports: `80` (HTTP), `443` (HTTPS), `2222` (SSH proxy).

Verify virtualization before going further:

```bash
ls /dev/kvm                      # must exist
grep -cE 'vmx|svm' /proc/cpuinfo # must be > 0
```

## Prerequisites

Before installing Atelier, your cluster needs several system components.

### 1. k3s

Install k3s with the default Traefik ingress controller:

```bash
curl -sfL https://get.k3s.io | sh -
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl get nodes   # node should be Ready
```

### 2. Helm

```bash
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
```

### 3. cert-manager

Atelier uses cert-manager for automatic wildcard TLS certificates via Let's Encrypt:

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true
```

### 4. Kata Containers

Kata Containers provides the VM isolation for sandboxes. Install the runtime with `kata-deploy`:

```bash
git clone --depth 1 https://github.com/kata-containers/kata-containers.git /tmp/kata-src
helm install kata-deploy /tmp/kata-src/tools/packaging/kata-deploy/helm-chart/kata-deploy \
  --set k8sDistribution=k3s \
  --set env.createRuntimeClasses=true \
  --set env.createDefaultRuntimeClass=true
```

Verify the `kata-clh` RuntimeClass exists:

```bash
kubectl get runtimeclass kata-clh
```

### 5. Storage and snapshots (optional — required for prebuilds)

Prebuilds and instant sandbox cloning need a CSI driver with VolumeSnapshot support. TopoLVM on an LVM thin pool is recommended for bare metal. **Without this, Atelier still works — prebuilds are disabled automatically.**

First, create an LVM thin pool on a spare disk or partition:

```bash
pvcreate /dev/nvme1n1
vgcreate atelier-vg /dev/nvme1n1
lvcreate -l 95%FREE --thinpool pool0 atelier-vg
```

Install the CSI snapshot controller:

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/master/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/master/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml
```

Install TopoLVM, pointing it at your volume group:

```bash
helm repo add topolvm https://topolvm.github.io/topolvm
helm install topolvm topolvm/topolvm \
  --namespace topolvm-system --create-namespace \
  --set lvmd.deviceClasses[0].name=thin \
  --set lvmd.deviceClasses[0].volume-group=atelier-vg \
  --set lvmd.deviceClasses[0].type=thin \
  --set lvmd.deviceClasses[0].thin-pool.name=pool0 \
  --set lvmd.deviceClasses[0].thin-pool.overprovision-ratio=10 \
  --set lvmd.deviceClasses[0].default=true
```

Then enable snapshots in your Atelier values (step below):

```yaml
kubernetes:
  storageClass: topolvm-provisioner
snapshots:
  createSnapshotClass: true
  driver: topolvm.io
```

## Installation

Installation has two independent phases: the **shared infra chart**
(`charts/atelier`) and the **server + console app** (`infra/k8s/v2`).

### 1. Create a GitHub OAuth App

Atelier authenticates users via GitHub OAuth. Create an OAuth App at <https://github.com/settings/developers> with:

- **Homepage URL**: `https://atelier.your-domain.com`
- **Authorization callback URL**: `https://atelier.your-domain.com/auth/callback`

### 2. Create a Cloudflare API token

cert-manager needs a Cloudflare API token to solve the DNS-01 challenge for the wildcard certificate. Create one with `Zone → DNS → Edit` permission on your domain's zone.

### 3. Prepare values.yaml (shared infra chart)

Create a `values.production.yaml`. This is the minimal working configuration:

```yaml
certManager:
  cloudflare:
    apiToken: "your-cloudflare-token"
```

Every available option is documented in [Advanced Configuration](advanced-configuration.md).

### 4. Deploy the shared infra chart

From the repository root:

```bash
helm upgrade --install atelier ./charts/atelier \
  --namespace atelier-system \
  --create-namespace \
  --values values.production.yaml
```

Alternatively, from a dev machine, the deploy script builds the sandbox agent image, pushes it, and deploys the chart over SSH:

```bash
VALUES_FILE=./values.production.yaml ./scripts/deploy-k8s.sh
```

This gives you Zot, CLIProxyAPI, sshpiper, cert-manager issuers, and the Kata
`RuntimeClass` — but not the app itself yet.

### 5. Deploy the server + console app

Edit `infra/k8s/v2/30-config.yaml` for your domain and cluster settings (see
[Advanced Configuration](advanced-configuration.md#app-configuration-infrak8sv230-configyaml--secrets)),
create the `atelier-v2-secrets` Secret (GitHub OAuth, JWT, secrets key, MCP
token, CLIProxy key), then apply the manifests in order — full sequence in
[`infra/k8s/v2/README.md`](../infra/k8s/v2/README.md):

```bash
kubectl apply -f infra/k8s/v2/00-namespaces.yaml
kubectl apply -f infra/k8s/v2/10-rbac.yaml
# kata custom runtime (virtiofsd --xattr) — needed once per cluster:
helm upgrade kata-deploy oci://ghcr.io/kata-containers/kata-deploy-charts/kata-deploy \
  --version 3.31.0 -n default -f infra/k8s/v2/kata-atelier-values.yaml
kubectl apply -f infra/k8s/v2/30-config.yaml
kubectl apply -f infra/k8s/v2/40-server-pvc.yaml
# create the atelier-v2-secrets Secret, then:
kubectl apply -f infra/k8s/v2/50-deployment.yaml
kubectl apply -f infra/k8s/v2/60-service.yaml
kubectl apply -f infra/k8s/v2/70-ingress.yaml
```

### 6. Expose the SSH proxy (optional)

sshpiper listens on NodePort `30022`. To offer SSH on the documented port `2222`, add a DNAT rule on the host:

```bash
iptables -t nat -A PREROUTING -p tcp --dport 2222 -j REDIRECT --to-port 30022
```

(or adjust `sshpiper.nodePort` / your firewall to taste).

## Post-install

### Verify deployment

```bash
kubectl get pods -n atelier-system      # shared infra
kubectl get pods -n atelier-v2-system   # server + console app
```

All pods should reach `Running`. The wildcard certificate can take a couple of minutes:

```bash
kubectl get certificates -n atelier-system   # READY should become True
```

### Access the console

Open the domain you set in `infra/k8s/v2/30-config.yaml` (`domain.dashboard`) and log in with GitHub.

### Build a base image

Sandboxes boot from base images stored in the internal Zot registry. There is
no build-from-UI feature — base images are built in-cluster with BuildKit,
not from the console. See
[`infra/k8s/v2/README.md`](../infra/k8s/v2/README.md#rebuild-images-in-cluster-no-local-docker)
to build/push `dev-base` (and optionally `dev-cloud`) before spawning your
first sandbox.

### Create your first saved spec

From the console, define a saved spec: git repos to clone, init commands, dev
commands, ports, and secrets. Optionally run a **prebuild** so subsequent
sandboxes spawn instantly from a snapshot.

## Updating

Pull the latest changes and run the Helm upgrade again:

```bash
helm upgrade atelier ./charts/atelier \
  --namespace atelier-system \
  --values values.production.yaml
```

> **Note:** if you changed `cliproxy.apiKeys`, `cliproxy.extraConfig`, or ports, check the [CLIProxy config seeding warning](advanced-configuration.md#cliproxyapi-ai-model-proxy) first.

## Manual TLS

If you prefer to manage certificates manually instead of using cert-manager:

1. Set `certManager.enabled: false` in your values.
2. Create a TLS secret named `atelier-tls` in the `atelier-system` namespace containing your wildcard certificate.
3. Update the ingress configuration to reference this secret.

## Troubleshooting

### Server logs

If the console is unreachable or sandboxes fail to start:

```bash
kubectl logs -n atelier-v2-system -l app.kubernetes.io/component=server -c server
```

### Sandbox pods

Sandboxes run in the namespace set by `kubernetes.namespace` in `infra/k8s/v2/30-config.yaml` (e.g. `atelier-v2-sandboxes`):

```bash
kubectl get pods -n atelier-v2-sandboxes
kubectl describe pod -n atelier-v2-sandboxes <pod-name>
```

### Common issues

- **Sandbox pods stuck in `ContainerCreating`** — ensure `/dev/kvm` exists on the host and `kubectl get runtimeclass kata-clh` succeeds. Check `kubectl get pods -n kube-system -l name=kata-deploy`.
- **TLS certificate pending** — inspect cert-manager:
  ```bash
  kubectl get certificates -n atelier-system
  kubectl get challenges --all-namespaces
  kubectl logs -n cert-manager -l app.kubernetes.io/component=controller
  ```
  Most often the Cloudflare token lacks DNS edit permission on the zone.
- **Prebuilds disabled at startup** — the server couldn't find a working VolumeSnapshotClass. Verify the snapshot controller and TopoLVM are installed and `snapshots.driver` (chart) / `kubernetes.volumeSnapshotClass` (app config) match your CSI driver.
- **DNS resolution** — verify both `your-domain.com` and `*.your-domain.com` resolve to the server's public IP.
- **WebSockets dropping behind Cloudflare proxy** — disable Rocket Loader (see [Constraints](constraints.md#cloudflare)).
