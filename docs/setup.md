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
- A domain with wildcard DNS: `your-domain.com` and `*.your-domain.com` pointing to the server IP (each sandbox tool gets its own `{tool}-{id}.your-domain.com` host).
- Open inbound ports: `80` (HTTP, also used by HTTP-01 certificate challenges), `443` (HTTPS), and the SSH NodePort (`30222` by default).

Verify virtualization before going further:

```bash
ls /dev/kvm                      # must exist
grep -cE 'vmx|svm' /proc/cpuinfo # must be > 0
```

## Prerequisites

Before installing Atelier, your cluster needs several system components.
Atelier does not install any of them: the app config
(`infra/k8s/v2/30-config.yaml`) references each one by name. The table in
[`infra/k8s/v2/README.md`](../infra/k8s/v2/README.md#cluster-prerequisites-not-managed-from-this-repo)
lists which config key points at which resource.

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

### 3. cert-manager + a ClusterIssuer

The console Ingress and every per-sandbox tool Ingress get a per-host Let's
Encrypt certificate from a ClusterIssuer you create (HTTP-01 is enough; no
wildcard certificate is needed):

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true

kubectl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
spec:
  acme:
    email: admin@your-domain.com
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-account-key
    solvers:
      - http01:
          ingress:
            ingressClassName: traefik
EOF
```

Set its name in `30-config.yaml` (`kubernetes.toolIngressClusterIssuer`) and in
the `cert-manager.io/cluster-issuer` annotation of `70-ingress.yaml`.

### 4. Kata Containers + the atelier runtime

Kata Containers provides the VM isolation for sandboxes. Atelier needs the
`kata-atelier-clh-rs` custom runtime (runtime-rs Cloud Hypervisor + a drop-in
for the raw-block workspace volume, with a 384Mi pod overhead). Install
`kata-deploy` with the values from this repo, which also define the
Go-runtime `kata-atelier-clh` as a rollback:

```bash
helm install kata-deploy \
  oci://ghcr.io/kata-containers/kata-deploy-charts/kata-deploy \
  -n default -f infra/k8s/v2/kata-atelier-values.yaml
```

Verify the RuntimeClass exists and the node is labelled:

```bash
kubectl get runtimeclass kata-atelier-clh-rs
kubectl get node -L kata-deploy.katacontainers.io/default
```

Two node settings keep the pod memory limit bounding the whole VM, and on AMD
hosts let runtime-rs start at all. See [Constraints](constraints.md) and the
header of `infra/k8s/v2/kata-atelier-values.yaml`:

- If the LVM thin pool sits on a loop device over a file, attach it with
  `losetup --direct-io=on`.
- On AMD CPUs without usable SEV (e.g. Ryzen): `options kvm_amd sev=0` in
  `/etc/modprobe.d/`, then reload `kvm_amd` or reboot.

`infra/k8s/v2/kata-eval/validate.sh kata-atelier-clh-rs` checks the result.

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

Create a VolumeSnapshotClass for it:

```bash
kubectl apply -f - <<'EOF'
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: atelier-snapshots
driver: topolvm.io
deletionPolicy: Delete
EOF
```

Then point `kubernetes.storageClass` (the TopoLVM StorageClass; it must allow
`volumeMode: Block`) and `kubernetes.volumeSnapshotClass` at them in
`infra/k8s/v2/30-config.yaml`.

### 6. OCI registry and image builds

Base images and toolset artifacts are pushed to an OCI registry the cluster can
pull from (e.g. [Zot](https://zotregistry.dev)); set it as
`kubernetes.registryUrl` (`host:port`). A plain-HTTP in-cluster registry must
also be declared as a mirror in `/etc/rancher/k3s/registries.yaml` so
containerd can pull from it.

Images are built with BuildKit (`imageBuilder` in `30-config.yaml`). Point
`imageBuilder.endpoint` at an existing `buildkitd`, or leave it empty to run
BuildKit daemonless inside the build Job.

## Installation

### 1. Create a GitHub OAuth App

Atelier authenticates users via GitHub OAuth. Create an OAuth App at <https://github.com/settings/developers> with:

- **Homepage URL**: `https://atelier.your-domain.com`
- **Authorization callback URL**: `https://atelier.your-domain.com/auth/callback`

### 2. Deploy the server + console app

Edit `infra/k8s/v2/30-config.yaml` for your domain and cluster settings (see
[Advanced Configuration](advanced-configuration.md#app-configuration-infrak8sv230-configyaml--secrets)),
create the `atelier-v2-secrets` Secret (GitHub OAuth, JWT, secrets key, MCP
token, CLIProxy key), then apply the manifests in order — full sequence in
[`infra/k8s/v2/README.md`](../infra/k8s/v2/README.md):

```bash
kubectl apply -f infra/k8s/v2/00-namespaces.yaml
kubectl apply -f infra/k8s/v2/10-rbac.yaml
kubectl apply -f infra/k8s/v2/30-config.yaml
kubectl apply -f infra/k8s/v2/40-server-pvc.yaml
# create the atelier-v2-secrets Secret, then:
kubectl apply -f infra/k8s/v2/50-deployment.yaml
kubectl apply -f infra/k8s/v2/60-service.yaml
kubectl apply -f infra/k8s/v2/70-ingress.yaml
```

### 3. Expose SSH (optional)

The server runs its own SSH gateway (`domain.ssh.gateway: in-server`),
exposed by `60-service.yaml` on NodePort `30222`. Open that port on the host
firewall. `domain.ssh.port` in `30-config.yaml` must equal the NodePort: it's
the port advertised in each sandbox's SSH URL.

## Post-install

### Verify deployment

```bash
kubectl get pods -n atelier-v2-system   # server + console app
```

The pod should reach `Running`. The console certificate can take a couple of minutes:

```bash
kubectl get certificates -n atelier-v2-system   # READY should become True
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

Rebuild the server + console images and roll the Deployment (see
[`infra/k8s/v2/README.md`](../infra/k8s/v2/README.md#rebuild-images-in-cluster-no-local-docker)),
and re-apply any changed manifests under `infra/k8s/v2/`.

## Manual TLS

If you prefer to manage certificates manually instead of using cert-manager:

1. Remove the cert-manager annotations from `70-ingress.yaml` and create the
   TLS Secret it references (`spec.tls[].secretName`) yourself.
2. Leave `kubernetes.toolIngressClusterIssuer` empty in `30-config.yaml` and
   provide the per-tool TLS some other way (e.g. a wildcard default
   certificate in Traefik).

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

- **Sandbox pods stuck in `ContainerCreating`** — ensure `/dev/kvm` exists on the host and `kubectl get runtimeclass kata-atelier-clh-rs` succeeds. On AMD, a `SEV not supported` event means `kvm_amd sev` must be disabled (see above). Check `kubectl get pods -n kube-system -l name=kata-deploy`.
- **Sandbox pods stuck in `Pending`** — the `kata-atelier-clh-rs` RuntimeClass only schedules onto nodes labelled `kata-deploy.katacontainers.io/default=true` (set by kata-deploy), and adds a per-pod overhead of 250m CPU / 384Mi: check `kubectl describe pod` for the scheduling reason.
- **TLS certificate pending** — inspect cert-manager:
  ```bash
  kubectl get certificates -A
  kubectl get challenges --all-namespaces
  kubectl logs -n cert-manager -l app.kubernetes.io/component=controller
  ```
  With HTTP-01, port 80 must be reachable from the internet and the host must resolve to the server.
- **Prebuilds disabled at startup** — the server couldn't find a working VolumeSnapshotClass. Verify the snapshot controller and TopoLVM are installed and the VolumeSnapshotClass named by `kubernetes.volumeSnapshotClass` (app config) uses your CSI driver.
- **DNS resolution** — verify both `your-domain.com` and `*.your-domain.com` resolve to the server's public IP.
- **WebSockets dropping behind Cloudflare proxy** — disable Rocket Loader (see [Constraints](constraints.md#cloudflare)).
