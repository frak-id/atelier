# Atelier v2 — staging deploy (`hetzner-atelier`)

Standalone manifests for the v2 server + console under
`atelier.hetzner-staging.frak.id`. See `.notes/deploy-v2-staging.md` for the
full feasibility write-up.

## Cluster prerequisites (not managed from this repo)

Shared cluster infra is consumed by name only; nothing in this repo installs
or configures it. infra-core owns kata-deploy, cert-manager + the
ClusterIssuers, TopoLVM, Zot and CLIProxy (Pulumi). The old `charts/atelier`
infra chart and `scripts/deploy-k8s.sh` were removed so they can't conflict
with it.

| Dependency | Name atelier relies on | Where it's referenced |
|------------|------------------------|-----------------------|
| kata-deploy | RuntimeClass `kata-atelier-clh-rs` (`kata-atelier-clh` = rollback) | `30-config.yaml` `kubernetes.runtimeClass` |
| Node | thin-pool loop device with `--direct-io=on`; `kvm_amd sev=0` on AMD | `kata-atelier-values.yaml` header, `docs/constraints.md` |
| TopoLVM | StorageClass `topolvm-thin` (Block volumeMode + block snapshots) | `30-config.yaml` `kubernetes.storageClass` |
| CSI snapshots | VolumeSnapshotClass `atelier-snapshots` | `30-config.yaml` `kubernetes.volumeSnapshotClass` |
| Zot | `zot.zot.svc:5000` (plain HTTP, k3s `registries.yaml` mirror) | `30-config.yaml` `kubernetes.registryUrl`, `deploy.sh` |
| BuildKit | `tcp://buildkitd.buildkit.svc:1234` + Secret `buildkit-client-tls` | `30-config.yaml` `imageBuilder` |
| cert-manager | ClusterIssuer `letsencrypt-frak` | `30-config.yaml` `toolIngressClusterIssuer`, `70-ingress.yaml` |
| Verdaccio | `http://verdaccio.verdaccio.svc:4873` | `30-config.yaml` `npmRegistryUrl` |
| Traefik | IngressClass `traefik` | `30-config.yaml`, `70-ingress.yaml` |

The atelier-side requirements on the Kata runtime (what the sandbox guest
assumes) are recorded in `kata-atelier-values.yaml`; keep infra-core's
release in sync with it when either side changes.

## What it deploys

- `atelier-v2-system` ns: server+console Deployment, Service, Ingress, config
  ConfigMap, data PVC, RBAC (SA `atelier-v2`).
- `atelier-v2-sandboxes` ns: v2 sandbox pods land here. opencode +
  code-server are the `org-toolbox` built toolset artifact (published to Zot,
  materialized by the guest agent at boot into `~/.local`) — no PVC/Job
  (composed-prebuild-volumes.md §6 "kill shared-binaries").
- Runtime class: sandboxes run under `kata-atelier-clh-rs` (`30-config.yaml`),
  a kata-deploy `customRuntimes` = stock runtime-rs `clh-runtime-rs` + a Kata
  `config.d` drop-in (virtio-blk + `block_device_cache_direct`) and a 384Mi
  pod overhead, so the pod memory limit bounds the whole VM (see
  `kata-atelier-values.yaml`). `kata-atelier-clh` (Go runtime) stays defined
  as the rollback: workspace disks move between the two unchanged, so a
  rollback is flipping `runtimeClass` back + pause/resume. Gate any runtime
  change with `kata-eval/validate.sh` (see `kata-eval/README.md`).
  The workspace PVC is a `volumeMode: Block` volume; Kata passes it to the
  guest as virtio-blk and the guest formats/mounts ext4 at `/data`, giving
  overlayfs real `trusted.overlay.*` (no `userxattr`) — Option C of
  `docs/plans/toolset-inplace-update-fix-options.md`. Defined as a
  kata-deploy custom runtime (infra-core's release), so it survives
  kata-deploy rolls. The storage class (`topolvm-thin`) must permit
  `Block` volumeMode and block-volume snapshots (TopoLVM thin does).
- Images: `zot.zot.svc:5000/atelier-server:v2` + `atelier-console:v2`
  (built in-cluster via BuildKit, pushed to the internal Zot registry).

## Secret (not in git)

The Deployment reads `atelier-v2-secrets`. Create it before deploying:

```sh
kubectl --context hetzner-atelier -n atelier-v2-system create secret generic atelier-v2-secrets \
  --from-literal=ATELIER_GITHUB_CLIENT_ID=<id> \
  --from-literal=ATELIER_GITHUB_CLIENT_SECRET=<secret> \
  --from-literal=ATELIER_JWT_SECRET=<jwt> \
  --from-literal=SANDBOX_SECRETS_KEY=<32-char-hex>
```

The GitHub OAuth app's callback URL must be
`https://atelier.hetzner-staging.frak.id/auth/callback`, org restricted to
`frak-id`.

## Apply

```sh
kubectl --context hetzner-atelier apply -f infra/k8s/v2/00-namespaces.yaml
kubectl --context hetzner-atelier apply -f infra/k8s/v2/10-rbac.yaml
# check the infra-core prerequisites above exist (at least the runtime class):
kubectl --context hetzner-atelier get runtimeclass kata-atelier-clh-rs
kubectl --context hetzner-atelier apply -f infra/k8s/v2/30-config.yaml
kubectl --context hetzner-atelier apply -f infra/k8s/v2/40-server-pvc.yaml
# create the secret (above), then:
kubectl --context hetzner-atelier apply -f infra/k8s/v2/50-deployment.yaml
kubectl --context hetzner-atelier apply -f infra/k8s/v2/60-service.yaml
kubectl --context hetzner-atelier apply -f infra/k8s/v2/70-ingress.yaml
```

## Rebuild images (in-cluster, no local docker)

Build with the cluster BuildKit and push to Zot — see
`.notes/deploy-v2-staging.md` (Phase A). `.dockerignore` must not exclude
workspace `apps/*` package.json files (bun frozen install needs the full
graph); the build pod uses a trimmed `.dockerignore`.
