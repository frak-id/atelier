# Setup

Atelier runs on a bare-metal Kubernetes cluster using k3s and Kata Containers. This guide covers the installation and configuration process using Helm.

## Requirements

### Hardware
- Bare-metal server (KVM virtualization is required).
- x86_64 CPU with VT-x or AMD-V enabled.
- Minimum 8GB RAM and 40GB storage.

### Software
- Debian 12 (Bookworm) or Ubuntu 22.04+.
- `/dev/kvm` must be accessible.

### Networking
- A domain with wildcard DNS support.
- `*.your-domain.com` and `your-domain.com` must point to the server IP.
- Ports `80` (HTTP) and `443` (HTTPS) open for web traffic.
- Port `2222` open for the SSH proxy.

## Prerequisites

Before installing Atelier, your cluster needs several system components.

### 1. k3s
Install k3s with the default Traefik ingress controller:

```bash
curl -sfL https://get.k3s.io | sh -
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
```

### 2. cert-manager
Atelier uses cert-manager for automatic TLS certificates via Let's Encrypt.

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true
```

### 3. Kata Containers
Kata Containers provides the VM isolation for sandboxes. Use `kata-deploy` to install the runtime:

```bash
git clone --depth 1 https://github.com/kata-containers/kata-containers.git /tmp/kata-src
helm install kata-deploy /tmp/kata-src/tools/packaging/kata-deploy/helm-chart/kata-deploy \
  --set k8sDistribution=k3s \
  --set env.createRuntimeClasses=true \
  --set env.createDefaultRuntimeClass=true
```

Verify the installation by checking for the `kata-clh` RuntimeClass:

```bash
kubectl get runtimeclass kata-clh
```

### 4. Storage and Snapshots (Optional)
To enable instant sandbox cloning and prebuilds, you need a CSI driver that supports snapshots. TopoLVM is recommended for bare-metal LVM thin provisioning.

```bash
# Install CSI snapshot controller
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/master/deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml
kubectl apply -f https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/master/deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml

# Install TopoLVM
helm repo add topolvm https://topolvm.github.io/topolvm
helm install topolvm topolvm/topolvm --namespace topolvm-system --create-namespace
```

## Installation

### 1. Create a GitHub OAuth App
Atelier requires GitHub OAuth for authentication.
- **Homepage URL**: `https://sandbox.your-domain.com`
- **Authorization callback URL**: `https://sandbox.your-domain.com/auth/callback`

### 2. Prepare values.yaml
Create a `values.yaml` file with your specific configuration. Use `charts/atelier/values.yaml` as a reference.

```yaml
domain:
  baseDomain: your-domain.com
  tls:
    email: admin@your-domain.com

auth:
  github:
    clientId: "your-client-id"
    clientSecret: "your-client-secret"
  allowedOrg: "your-github-org" # Optional

certManager:
  cloudflare:
    apiToken: "your-cloudflare-token" # Required for DNS-01 challenge
```

### 3. Deploy with Helm
Run the following command from the repository root:

```bash
helm upgrade --install atelier ./charts/atelier \
  --namespace atelier-system \
  --create-namespace \
  --values values.yaml
```

## Configuration

Key configuration sections in `values.yaml`:

- **domain**: Sets the base domain and TLS contact email.
- **auth**: Configures GitHub OAuth and JWT secrets. You can restrict access to specific organizations or users.
- **kubernetes**: Defines the namespace for sandboxes and the runtime class (defaults to `kata-clh`).
- **certManager**: Configures the ACME issuer. Currently, the chart supports Cloudflare DNS-01 for wildcard certificates.
- **zot**: Enables the internal OCI registry for base images.
- **sshpiper**: Enables the SSH proxy on port 2222.

## Post-install

### Verify Deployment
Check that all pods are running in the `atelier-system` namespace:

```bash
kubectl get pods -n atelier-system
```

### Access the Dashboard
The dashboard is available at `https://sandbox.your-domain.com`. Log in using your GitHub account.

### Build Base Images
Atelier uses the internal Zot registry to store sandbox base images. Build the default `dev-base` image from the dashboard (Settings > Images) or verify it exists:

```bash
kubectl logs -n atelier-system -l app.kubernetes.io/component=manager -c manager | grep -i image
```

## Updating

To update Atelier to a new version, pull the latest changes and run the Helm upgrade command again:

```bash
helm upgrade atelier ./charts/atelier \
  --namespace atelier-system \
  --values values.yaml
```

## Manual TLS

If you prefer to manage certificates manually instead of using cert-manager:
1. Set `certManager.enabled: false` in your `values.yaml`.
2. Create a TLS secret named `atelier-tls` in the `atelier-system` namespace containing your wildcard certificate.
3. Update the ingress configuration to reference this secret.

## Troubleshooting

### Check Manager Logs
If the dashboard is unreachable or sandboxes fail to start, check the manager logs:

```bash
kubectl logs -n atelier-system -l app.kubernetes.io/component=manager -c manager
```

### Inspect Sandbox Pods
Sandboxes run in the `atelier-sandboxes` namespace. If a sandbox fails to boot, describe the pod to see the events:

```bash
kubectl describe pod -n atelier-sandboxes <pod-name>
```

### Common Issues
- **Kata Containers not starting**: Ensure `/dev/kvm` is available on the host and the `kata-clh` RuntimeClass exists.
- **TLS Certificate pending**: Check the cert-manager logs and certificate resources:
  ```bash
  kubectl get certificates -n atelier-system
  kubectl get challenges --all-namespaces
  kubectl logs -n cert-manager -l app.kubernetes.io/component=controller
  ```
- **DNS Resolution**: Verify that your wildcard DNS record correctly points to the server's public IP.
