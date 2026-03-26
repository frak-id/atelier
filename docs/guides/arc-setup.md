# GitHub Actions Runner Controller (ARC)

This guide covers the installation and configuration of GitHub Actions Runner Controller (ARC v2) with Kata Containers isolation, integrated with the Atelier dashboard.

Using ARC with Atelier provides VM-isolated CI runners that execute untrusted code from pull requests in secure, lightweight virtual machines. The Atelier dashboard provides real-time monitoring of runner status and resource usage.

## Prerequisites

Before installing ARC, ensure your environment meets these requirements:

- **Atelier deployed**: A working Atelier installation on Kubernetes.
- **Kata Containers**: The `kata-clh` RuntimeClass must be available in the cluster.
- **Helm**: Helm v3 installed and configured.
- **GitHub Access**: A GitHub App or Personal Access Token (PAT) with appropriate permissions.

## Step 1: Install ARC Controller

The controller manages the runner scale sets and communicates with GitHub. Install it in the `arc-systems` namespace:

```bash
helm install arc \
  --namespace arc-systems \
  --create-namespace \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller
```

## Step 2: Create GitHub App

GitHub Apps are the recommended authentication method for ARC.

1. Navigate to your GitHub Organization or Repository settings.
2. Go to **Settings > Developer settings > GitHub Apps > New GitHub App**.
3. Set the following permissions:
   - **Organization Permissions** (for Org runners):
     - Self-hosted runners: Read & write
     - Administration: Read & write
   - **Repository Permissions** (for Repo runners):
     - Administration: Read & write
4. Generate a **Private key** and download the `.pem` file.
5. Note the **App ID** and **Installation ID** (found in the App's "Install App" section after installing it to your org/repo).

## Step 3: Create auth secret

Create the runner namespace and a Kubernetes secret containing your GitHub App credentials. Replace the placeholders with your actual values:

```bash
kubectl create namespace arc-runners

kubectl create secret generic pre-defined-secret \
  --namespace arc-runners \
  --from-literal=github_app_id=123456 \
  --from-literal=github_app_installation_id=654321 \
  --from-literal=github_app_private_key='-----BEGIN RSA PRIVATE KEY-----
  ...
  -----END RSA PRIVATE KEY-----'
```

Alternatively, if using a PAT:

```bash
kubectl create namespace arc-runners  # skip if already created

kubectl create secret generic pre-defined-secret \
  --namespace arc-runners \
  --from-literal=github_token='ghp_your_pat_here'
```

## Step 4: Install Runner Scale Set

The Runner Scale Set defines the runner configuration and scaling parameters. Create a `runners.yaml` file:

```yaml
githubConfigUrl: "https://github.com/your-org-or-repo"
githubConfigSecret: pre-defined-secret

containerMode:
  type: "kubernetes"

template:
  spec:
    runtimeClassName: kata-clh
    containers:
      - name: runner
        image: ghcr.io/actions/actions-runner:latest
        command: ["/home/runner/run.sh"]

# Scaling configuration
minRunners: 1
maxRunners: 10

# Runner group and labels
runnerGroup: "default"
labels:
  - "kata-runner"
```

Install the scale set using Helm:

```bash
helm install arc-runner-set \
  --namespace arc-runners \
  --create-namespace \
  -f runners.yaml \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
```

## Step 5: Configure Atelier

Update your Atelier `values.yaml` to enable runner monitoring. This allows the dashboard to track runner pods in the `arc-runners` namespace.

```yaml
runners:
  enabled: true
  namespace: arc-runners
  labelSelector: "app.kubernetes.io/component=runner"
```

Apply the changes:

```bash
helm upgrade atelier ./charts/atelier \
  --namespace atelier-system \
  --values values.yaml
```

## Step 6: Verify

### Check Runner Pods
Verify that the runner pods are starting in the `arc-runners` namespace:

```bash
kubectl get pods -n arc-runners
```

### Check GitHub Settings
Navigate to your GitHub Organization or Repository **Settings > Actions > Runners**. You should see the new runner scale set listed as "Online".

### Check Atelier Dashboard
Open the Atelier dashboard and navigate to the **Platform** page. The runners should appear in the monitoring section with their current status and resource usage.

## Configuring GitHub Actions Workflows

To use the Kata-isolated runners in your workflows, update the `runs-on` field to match the labels defined in your scale set:

```yaml
jobs:
  build:
    runs-on: arc-runner-set
    steps:
      - uses: actions/checkout@v4
      - run: echo "Running in a Kata VM"
```

## Scaling

ARC v2 automatically scales runners based on the number of pending jobs in your GitHub queue.

- **minRunners**: The number of idle runners to keep warm. Set to `0` to scale to zero when no jobs are active.
- **maxRunners**: The maximum number of concurrent runners allowed.
- **Scale-to-zero**: When `minRunners` is `0`, ARC will only spawn pods when a job is queued, saving resources when the CI pipeline is idle.

## Security

Using Kata Containers for GitHub Actions runners provides a critical security layer. Standard container-based runners share the host kernel, which can be exploited by malicious code in pull requests.

Kata VMs provide hardware-backed isolation, ensuring that even if a runner is compromised, the attacker cannot escape to the host or access other runners. This is highly recommended for any CI environment executing untrusted code.

## Troubleshooting

### Runners not registering
Check the logs of the `gha-runner-scale-set-controller` pod in the `arc-systems` namespace:

```bash
kubectl logs -n arc-systems -l app.kubernetes.io/name=gha-runner-scale-set-controller
```

### Kata pods failing
If runner pods fail to start, describe the pod to check for RuntimeClass or KVM errors:

```bash
kubectl describe pod -n arc-runners <pod-name>
```

### Atelier not showing runners
Ensure the `runners.namespace` and `runners.labelSelector` in your Atelier `values.yaml` match your ARC installation. The default label selector for ARC v2 is `app.kubernetes.io/component=runner`.
