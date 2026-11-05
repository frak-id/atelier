# Setup

Atelier runs on a bare-metal Kubernetes cluster using k3s and Kata Containers. This guide covers the full installation, from a fresh server to a working console.

Choosing hardware? See [Sizing](#sizing) below.

## Requirements

### Hardware
- Bare-metal server (KVM virtualization is required — `/dev/kvm` must exist).
- x86_64 CPU with VT-x or AMD-V enabled.
- Minimum 8 GB RAM and 40 GB storage (see [Sizing](#sizing)).

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

### Sizing

Atelier needs **bare metal with KVM**: Kata Containers boots a real
lightweight VM per sandbox. Most cloud VMs (AWS EC2, GCP, standard Hetzner
Cloud) don't support nested virtualization reliably, so rent a dedicated
server (e.g. a Hetzner AX-line box, OVH, Scaleway Elastic Metal, a homelab).
Single-node k3s is the recommended shape: one kubeconfig to back up, and
TopoLVM snapshots are node-local, so instant copy-on-write cloning works best
when all sandboxes share the node's LVM thin pool.

Each sandbox is a VM with its own kernel plus its workloads (code-server,
OpenCode, Chromium, dev servers). Budget roughly **2-4 GB RAM and 1-2 vCPU per
active sandbox**, plus ~4 GB for the system (k3s, the server, Zot). Kata adds
a fixed per-sandbox overhead (250m CPU / 384Mi with the `kata-atelier-clh-rs`
runtime). A sandbox's memory size is its VM's entire RAM, page cache included.

| Team size | Concurrent sandboxes | RAM | CPU | Storage |
|-----------|---------------------|-----|-----|---------|
| Solo / trying it out | 2-4 | 16 GB | 4-6 cores | 250 GB NVMe |
| Small team | 5-10 | 64 GB | 8 cores / 16 threads | 512 GB - 1 TB NVMe |
| Larger team | 15-20+ | 128 GB | 16 cores / 32 threads | 2 x 1 TB NVMe |

For prebuilds, leave a second NVMe drive (or a large partition) unformatted
for the LVM thin pool ([step 5](#5-storage-and-snapshots-optional--required-for-prebuilds)).

## Prerequisites

Before installing Atelier, your cluster needs several system components.
Atelier does not install any of them: the app config
(`infra/k8s/30-config.yaml`) references each one by name. The table in
[`infra/k8s/README.md`](../infra/k8s/README.md#cluster-prerequisites-not-managed-from-this-repo)
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
  -n default -f infra/k8s/kata-atelier-values.yaml
```

Verify the RuntimeClass exists and the node is labelled:

```bash
kubectl get runtimeclass kata-atelier-clh-rs
kubectl get node -L kata-deploy.katacontainers.io/default
```

Two node settings keep the pod memory limit bounding the whole VM, and on AMD
hosts let runtime-rs start at all. See [Constraints](constraints.md) and the
header of `infra/k8s/kata-atelier-values.yaml`:

- If the LVM thin pool sits on a loop device over a file, attach it with
  `losetup --direct-io=on`.
- On AMD CPUs without usable SEV (e.g. Ryzen): `options kvm_amd sev=0` in
  `/etc/modprobe.d/`, then reload `kvm_amd` or reboot.

`infra/k8s/kata-eval/validate.sh kata-atelier-clh-rs` checks the result.

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
`infra/k8s/30-config.yaml`.

### 6. OCI registry and image builds

Base images and toolset artifacts are pushed to an OCI registry the cluster can
pull from (e.g. [Zot](https://zotregistry.dev)); set it as
`kubernetes.registryUrl` (`host:port`). A plain-HTTP in-cluster registry must
also be declared as a mirror in `/etc/rancher/k3s/registries.yaml` so
containerd can pull from it.

Images are built with BuildKit (`imageBuilder` in `30-config.yaml`): set
`imageBuilder.kind` to `buildkit` and `imageBuilder.endpoint` to an existing
`buildkitd`. The endpoint is required; daemonless builds were removed.

## Installation

### 1. Create a GitHub OAuth App

Atelier authenticates users via GitHub OAuth. Create an OAuth App at <https://github.com/settings/developers> with:

- **Homepage URL**: `https://atelier.your-domain.com`
- **Authorization callback URL**: `https://atelier.your-domain.com/auth/callback`

### 2. Deploy the server + console app

Edit `infra/k8s/30-config.yaml` for your domain and cluster settings (see
[Advanced Configuration](advanced-configuration.md#config-file)),
create the `atelier-v2-secrets` Secret (GitHub OAuth client id and secret, JWT
secret, secrets-at-rest key), then apply the manifests in order — full sequence in
[`infra/k8s/README.md`](../infra/k8s/README.md):

```bash
kubectl apply -f infra/k8s/00-namespaces.yaml
kubectl apply -f infra/k8s/10-rbac.yaml
kubectl apply -f infra/k8s/30-config.yaml
kubectl apply -f infra/k8s/40-server-pvc.yaml
# create the atelier-v2-secrets Secret, then:
kubectl apply -f infra/k8s/50-deployment.yaml
kubectl apply -f infra/k8s/60-service.yaml
kubectl apply -f infra/k8s/70-ingress.yaml
kubectl apply -f infra/k8s/80-forward-auth.yaml   # forward-auth + wake middlewares
kubectl apply -f infra/k8s/85-network-policy.yaml # default-deny for sandbox pods
```

Set `auth.defaultOrg` in `30-config.yaml` to the slug of your team org
(see [Default org](#3-default-org)). `SANDBOX_SECRETS_KEY` in the Secret is
required: the server refuses to start in production without it.

### 3. Default org

`auth.defaultOrg` names the team organization. Every user who passes the
GitHub gate joins it as `member` on first login, and it is the default org for
new sandboxes. Its **owners are the server admins**: they edit the operational
config, build and delete images, publish toolsets, delete prebuilds and use
`/mcp/admin`. If the org does not exist yet, the first user to sign in creates
it and becomes its owner. Production refuses to start without `auth.defaultOrg`.

### 4. Expose SSH (optional)

The server runs its own SSH gateway, exposed by `60-service.yaml` on NodePort
`30222`. Open that port on the host
firewall. `domain.ssh.port` in `30-config.yaml` must equal the NodePort: it's
the port advertised in each sandbox's SSH URL.

Recommended hardening: restrict everything but `80`, `443` and the SSH
NodePort (e.g. a provider firewall), and allow-list `6443` (k3s API) to your
own IP.

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

Open the domain you set in `infra/k8s/30-config.yaml` (`domain.dashboard`) and log in with GitHub.

### Build a base image

Sandboxes boot from base images stored in the internal Zot registry. Base
images are the embedded seeds (`dev-base`, `dev-cloud`, `dev-rust`,
`dev-browser`) built by the server through BuildKit, or external refs you
register. A server admin builds a seed from Library > Images in the console.
To bootstrap a fresh registry out-of-band, see
[`infra/k8s/README.md`](../infra/k8s/README.md#rebuild-images-in-cluster-no-local-docker).
Custom Dockerfile and zip builds do not exist.

### Spawn your first sandbox

Open Spawn in the console, pick a repo and a branch, and start. Optionally
create a **prebuild** (Library > Prebuilds) so later sandboxes boot from a
snapshot in seconds. Agents can do the same over MCP, see the
[README](../README.md#mcp).

## Network, domains and cleanup

```
Internet -> Traefik (:443, TLS) -> Ingress -> Service -> Pod:port
```

- Sandbox pods get IPs from the CNI (10.42.x.x on k3s); each sandbox has its
  own Service and per-tool Ingress (host-based routing).
- Domains (`domain.baseDomain`, `domain.dashboard`):

  | Service | URL pattern |
  |---------|-------------|
  | Console | `{domain.dashboard}` (empty = `sandbox.{baseDomain}`) |
  | VS Code | `sandbox-{id}.{baseDomain}` |
  | OpenCode | `opencode-{id}.{baseDomain}` |
  | Browser | `browser-{id}.{baseDomain}` |
  | Dev command | `dev-{name}-{id}.{baseDomain}` |

- The in-pod agent listens on TCP 9998 (HTTP: config, processes, exec, files)
  and 9997 (attach bridge: process attach, ACP and terminals). Both need the
  sandbox's bearer token. The server reaches them via the pod IP
  (`pod.status.podIP`); its once-a-minute `GET /activity` poll for idle
  auto-pause never counts as activity.
- `85-network-policy.yaml` makes the sandbox namespace default-deny for
  ingress and allows only the Atelier server pod and the ingress controller
  (Traefik in `kube-system`). Egress is open.
- Sandbox destruction deletes every resource labelled
  `atelier.dev/sandbox={id}` (pods, services, configmaps, PVCs, ingresses,
  volumesnapshots), then the database record; Kubernetes garbage collection
  covers orphans.

| Resource | Namespace |
|----------|-----------|
| Sandbox Pod, Service, Ingress, workspace PVC, VolumeSnapshots | `kubernetes.namespace` (e.g. `atelier-v2-sandboxes`) |
| Server + console Deployment, SQLite PVC | system namespace (e.g. `atelier-v2-system`) |
| OCI registry (Zot) | cluster infra, not deployed by Atelier |

### Backups

Back up the server's SQLite PVC, your `30-config.yaml` edits and the
`atelier-v2-secrets` values. Zot holds rebuildable base images. Sandboxes are
disposable: anything important belongs in git.

## Updating

Rebuild the server and console images and roll the Deployment (see
[`infra/k8s/README.md`](../infra/k8s/README.md#rebuild-images-in-cluster-no-local-docker)),
and re-apply any changed manifests under `infra/k8s/`. `deploy.sh` applies
`60-service.yaml`, `80-forward-auth.yaml`, `85-network-policy.yaml` and
`30-config.yaml` before it rolls.

## Upgrading to this release

This release changes the agent protocol, the database, the config schema and
the MCP surface. Follow this order.

### Deploy order

1. **Back up the SQLite PVC.** Migration 0030 cannot be undone.
2. **Fix `30-config.yaml`** (see [Config file](#config-file-changes)). The new
   server refuses to start on an unknown key.
3. **Check the Secret** has `SANDBOX_SECRETS_KEY`. Production refuses to start
   without it. If the old deployment ran without one, its secrets were
   encrypted with the public dev key and cannot be read under a new key: re-enter
   them after the upgrade.
4. **Apply the manifests the new server depends on, before it rolls:**

   ```bash
   kubectl apply -f infra/k8s/80-forward-auth.yaml    # adds the atelier-wake middleware
   kubectl apply -f infra/k8s/85-network-policy.yaml  # default-deny ingress for sandbox pods
   kubectl apply -f infra/k8s/30-config.yaml          # wakeIngressAnnotations, defaultOrg
   ```

   The `atelier-wake` middleware must exist before an Ingress references it,
   or Traefik disables that route. The network policy admits the server pod by
   its labels (`app.kubernetes.io/component: server`), so applying it first is
   safe for the running server. It assumes Traefik runs in `kube-system` with
   the label `app.kubernetes.io/name=traefik`; if yours differs, edit both
   selectors in `85-network-policy.yaml` or tool URLs time out.
5. **Roll the server and the agent image together.** Build the server and
   console, and rebuild the seed images so they bake the new agent
   (`sandbox.agentImage` pins `ghcr.io/frak-id/sandbox-agent:<release>`; the
   release workflow publishes that tag):

   ```bash
   infra/k8s/deploy.sh server console
   ```

   Then rebuild `dev-base` and the other seeds from Library > Images (or
   `infra/k8s/deploy.sh agent dev-base`), and refresh your prebuilds.
6. **Verify.** Open the console, check the server log for the migration, and
   probe the network policy from one sandbox to another sandbox's agent
   (`:9998`): it must time out.

Why the order matters:

- The new agent requires a bearer token on HTTP and WebSocket. An old agent
  ignores the token, so a new server still drives old sandboxes.
- A new server dials terminals on the agent's attach port. An old agent has
  no terminal there, so **terminals fail on sandboxes that still run an old
  agent**. A sandbox gets the new agent only when it boots from an image that
  contains it. New sandboxes from rebuilt images do. Sandboxes and prebuilds
  that boot from a recorded image or snapshot may keep their old agent until
  you recreate them. The server logs a warning once per sandbox when the agent
  version differs from its own.

### Config file changes

- Remove every removed key from `30-config.yaml` and the Deployment env:
  `ports.terminal` / `ATELIER_TERMINAL_PORT`, `domain.ssh.gateway` /
  `ATELIER_SSH_GATEWAY`, `storage.provider` / `ATELIER_STORAGE_PROVIDER`,
  `domain.tls`, `server.maxSandboxes`, `server.maxActiveTasks`,
  `kubernetes.systemNamespace`, `sandbox.git`. See
  [Removed keys](advanced-configuration.md#removed-keys). A config file with an
  unknown key now fails at startup.
- Replace any `ATELIER_SERVER_MODE=mock` with `production` or `local`. Any
  other value fails at startup.
- Set `auth.defaultOrg` (or `ATELIER_DEFAULT_ORG`) to your team org slug.
  Production refuses to start without it.
- Add `kubernetes.wakeIngressAnnotations`. The shipped file points it at the
  `atelier-wake` middleware.
- Remove operational keys you want to keep editable from the console (idle
  rules, retention, default image and size). A key present in the file is
  locked. Infrastructure keys you edited in the console before are now read
  from the file or env, and the stored override is ignored.
- `imageBuilder.kind: buildkit` needs an `endpoint`.
- `ATELIER_MCP_TOKEN`, `ATELIER_CLIPROXY_*` and `ATELIER_INTEGRATION_*` are no
  longer read.

### Secrets key

`SANDBOX_SECRETS_KEY` encrypts stored secrets and, now, the GitHub access
tokens of users. Keep the existing value: changing it makes stored secrets
unreadable. Plaintext GitHub tokens already in the database are re-encrypted at
each user's next login.

### Migration 0030

It runs automatically at startup, in order, and it is one-way:

- Org roles: `admin` becomes `owner`, `viewer` becomes `member`.
- Toolboxes become org-owned. A user-owned toolbox moves to its owner's
  personal org (a clashing slug gets a short id suffix). Tables are renamed
  (`entity_toolboxes` to `toolboxes`, `entity_toolbox_versions` to
  `toolbox_versions`, `settings` to `server_config`).
- Each org policy becomes an auto-inject `org-defaults` toolbox holding the
  policy's files, processes, ports and harness. Policy hooks have no
  equivalent and are dropped. The `org_policy_specs` table is removed.
- The `integration_connections` table is dropped.
- Images with `dockerfile` provenance are deleted.
- New columns: `sandboxes.image`, `snapshots.kind` (backfilled to `prebuild`,
  `pause`, `fork` or `manual`) and `snapshots.repo_heads`. Dropped:
  `sandboxes.pod_name`, `sandboxes.pvc_name`, `toolsets.env`,
  `images.dockerfile`. New table: `agent_tasks`.
- `organizations.personal` becomes an integer flag.
- A data step for Frak's own deployment turns the `frak` personal org into a
  team org and gives its former owner a new personal org. It does nothing
  elsewhere.

After the migration, orphaned old pause snapshots appear as `manual` snapshots
and age out under `snapshot.manualKeep`. Stored specs of existing sandboxes
still hold resolved values until each one resumes; the resume replaces them
with the unresolved merged spec.

### Behaviour changes

- **MCP clients must reconnect.** The surface is split and renamed:
  `/mcp` has 13 tools and `/mcp/admin` has 4 (server admins only). `patch_files`
  is now `write_files`. `list_toolboxes` is now `manage_toolbox` with
  `action: "list"` on `/mcp/admin`. `destroy` is its own tool,
  `destroy_sandbox`. `manage_prebuilds`, `manage_toolbox`, `manage_images` and
  the new `server_config` moved to `/mcp/admin`. `create_sandbox` returns at
  once with a `jobId`. `get_sandbox` lists as `{sandboxes}` and `get_task` as
  `{tasks}`. `expose_port` takes `auth` instead of `public`. A session id from
  before the deploy answers 404, which makes spec-compliant clients start a new
  session.
- **Agents never wait for permission.** `manage_task action=reply_permission`,
  `send_prompt.autoApprove`, the `waiting_permission` status and the
  `/sessions/.../agent/permissions` and `questions` routes are gone.
- **Exec timeout.** A command with no timeout now stops after 30 s. Pass
  `timeoutMs` for longer jobs.
- **Roles.** Only `owner` and `member` exist. Server admins are the owners of
  the default org.
- **Toolboxes** are selected with `tb/<toolboxId>`. Org policy is replaced by
  toolbox `files`.
- **CLI.** The `atelier` CLI is removed. Use the console, MCP, or SSH. Routes
  that only the CLI used are gone (`POST /auth/api-token`, `GET /api/me`,
  `PATCH /v1/sandboxes/:id/env`, `POST /v1/sandboxes/:id/processes`,
  `POST /v1/sandboxes/:id/toolsets/capture`), as are `POST /v1/images` with a
  Dockerfile and `POST /v1/images/upload`.
- **Paused sandboxes keep their Service and Ingresses**, so they can wake on
  access. A sandbox paused before the upgrade has none; it recreates them on
  its next resume.
- **Preview Ingresses pick up `atelier-wake`** on their next resume.

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

Sandboxes run in the namespace set by `kubernetes.namespace` in `infra/k8s/30-config.yaml` (e.g. `atelier-v2-sandboxes`):

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
