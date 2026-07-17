# Atelier v2 — staging deploy (`hetzner-atelier`)

Standalone manifests to run the v2 server + console in parallel with the live
v1 stack, under `atelier.hetzner-staging.frak.id`. See
`.notes/deploy-v2-staging.md` for the full feasibility write-up.

## What it deploys

- `atelier-v2-system` ns: server+console Deployment, Service, Ingress, config
  ConfigMap, data PVC, RBAC (SA `atelier-v2`).
- `atelier-v2-sandboxes` ns: v2 sandbox pods land here. opencode +
  code-server are the `org-toolbox` built toolset artifact (published to Zot,
  materialized by the guest agent at boot into `~/.local`) — no PVC/Job
  (composed-prebuild-volumes.md §6 "kill shared-binaries").
- Runtime class: sandboxes run under `kata-atelier-clh` (`30-config.yaml`), a
  kata-deploy `customRuntimes` = stock `clh` + a Kata `config.d` drop-in that
  pins `block_device_driver = virtio-blk` (see `kata-atelier-values.yaml`).
  The workspace PVC is a `volumeMode: Block` volume; Kata passes it to the
  guest as virtio-blk and the guest formats/mounts ext4 at `/data`, giving
  overlayfs real `trusted.overlay.*` (no `userxattr`) — Option C of
  `docs/plans/toolset-inplace-update-fix-options.md`. Chart-managed, so it
  survives kata-deploy rolls. The storage class (`topolvm-thin`) must permit
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
# kata custom runtime (virtio-blk block passthrough) — needed once per cluster:
helm upgrade kata-deploy oci://ghcr.io/kata-containers/kata-deploy-charts/kata-deploy \
  --version 3.31.0 -n default -f infra/k8s/v2/kata-atelier-values.yaml
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
