# Advanced Configuration

Atelier deploys only the server + console app: plain Kubernetes manifests
under **`infra/k8s/v2`** (Deployment, Service, Ingress, config ConfigMap,
secrets, PVC, RBAC). See [`infra/k8s/v2/README.md`](../infra/k8s/v2/README.md)
for the full apply sequence.

Cluster infra (Kata runtime, cert-manager ClusterIssuer, TopoLVM + snapshot
class, OCI registry, BuildKit, CLIProxy) is installed separately and
referenced by name from the app config; see the [Setup Guide](setup.md#prerequisites).

For app-level settings (domain, auth, ports, sandbox defaults, MCP token,
CLIProxy wiring), edit `infra/k8s/v2/30-config.yaml` (non-secret config,
mounted as `/etc/atelier/sandbox.config.json`) and the `atelier-v2-secrets`
Secret (credentials) — see the schema reference below.

## App configuration (`infra/k8s/v2/30-config.yaml` + secrets)

The server reads a layered config: env vars > the mounted
`sandbox.config.json` > built-in defaults. The full schema lives in
`packages/shared/src/config.schema.ts`; the generated JSON Schema is at
`packages/shared/schemas/atelier.config.schema.json`.

```jsonc
{
  "domain": {
    "baseDomain": "example.com",     // REQUIRED — all services hang off this
    "dashboard": "atelier.example.com",
    "tls": { "email": "admin@example.com" },
    "ssh": { "port": 2222, "hostname": "ssh.example.com" }
  },
  "auth": {
    "allowedOrg": "my-github-org"    // optional GitHub org restriction
  },
  "server": {
    "mode": "production",
    "port": 4000,
    "host": "0.0.0.0",
    "maxSandboxes": 20,
    "maxActiveTasks": 10
  },
  "kubernetes": {
    "namespace": "atelier-v2-sandboxes",
    "systemNamespace": "atelier-v2-system",
    "runtimeClass": "kata-atelier-clh-rs",
    "ingressClassName": "traefik",
    "toolIngressClusterIssuer": "letsencrypt-prod",
    "registryUrl": "zot.zot.svc:5000",
    "npmRegistryUrl": "",
    "storageClass": "topolvm-thin",
    "volumeSnapshotClass": "atelier-snapshots",
    "defaultVolumeSize": "20Gi"
  },
  "sandbox": {
    "defaultImage": "dev-base-v2",
    "git": { "email": "sandbox@atelier.dev", "name": "Sandbox User" }
  }
}
```

Secrets (GitHub OAuth, JWT, secrets-at-rest key, MCP token, CLIProxy API key)
are injected via env from the `atelier-v2-secrets` Secret and override the
matching config fields — see `infra/k8s/v2/README.md` for the exact
`kubectl create secret` command.

Resulting URL patterns:

| Service | URL |
|---------|-----|
| Console | `{domain.dashboard}` |
| VS Code | `sandbox-{id}.{baseDomain}` |
| OpenCode | `opencode-{id}.{baseDomain}` |
| Browser (KasmVNC) | `browser-{id}.{baseDomain}` |
| Dev command | `dev-{name}-{id}.{baseDomain}` |

### Key environment variables (server)

Set directly on the Deployment (`infra/k8s/v2/50-deployment.yaml`); these
override the config file.

| Variable | Description |
|----------|-------------|
| `ATELIER_SERVER_MODE` | `production` or `mock` (local dev, no K8s/KVM) |
| `ATELIER_CONFIG` | Path to the mounted config JSON (default `/etc/atelier/sandbox.config.json`) |
| `ATELIER_GITHUB_CLIENT_ID` / `_SECRET` | GitHub OAuth credentials |
| `ATELIER_JWT_SECRET` | JWT signing secret |
| `SANDBOX_SECRETS_KEY` | Encrypts saved-spec/workspace secrets at rest |
| `ATELIER_MCP_TOKEN` | Bearer token enabling the MCP server (empty = disabled) |
| `ATELIER_CLIPROXY_URL` / `_API_KEY` | CLIProxy model provider baked into sandbox `opencode.json` at spec enrichment |

The full `ATELIER_*` → config-path mapping is `ENV_VAR_MAPPING` in
`packages/shared/src/config.schema.ts`.

### MCP server for AI agents

Set `ATELIER_MCP_TOKEN` (Secret key) to let external AI agents orchestrate
sandboxes via the Model Context Protocol (`/mcp`). Agents authenticate with
`Authorization: Bearer <token>`.

## Base images (dev-base, dev-cloud)

Production base images are typically built out-of-band with the cluster's
BuildKit (`buildctl`) against a shared `buildkitd` and pushed to Zot; see
`infra/k8s/v2/deploy.sh` and [`infra/k8s/v2/README.md`](../infra/k8s/v2/README.md#rebuild-images-in-cluster-no-local-docker).
The server also has a server-side build API (`POST /v1/images`,
`ImageBuilderService`) that uses the `imageBuilder.*` config — it's what the
`kind`/`endpoint`/etc. schema below actually drives; there's just no
build-from-console UI on top of it yet. `imageBuilder.kind=buildkit` with no
`endpoint` (the default) runs BuildKit daemonless in a one-shot Job, so an
in-cluster build needs no pre-existing daemon — the same zero-dependency
property `kind=kaniko` offered, without depending on the now-archived
upstream Kaniko project. `kind=kaniko` stays selectable but is deprecated.

## Recipes

### Use a different OCI registry

Point the app's `kubernetes.registryUrl` (in `infra/k8s/v2/30-config.yaml`) at
the registry's `host:port` (no scheme). A plain-HTTP registry must also be a
mirror in the node's `/etc/rancher/k3s/registries.yaml`.

### Enable prebuilds with TopoLVM

Create a `VolumeSnapshotClass` for the `topolvm.io` driver (see
[Setup → Storage and snapshots](setup.md#5-storage-and-snapshots-optional--required-for-prebuilds)),
then reference it and a Block-capable TopoLVM StorageClass:

```jsonc
// infra/k8s/v2/30-config.yaml
{
  "kubernetes": {
    "storageClass": "topolvm-provisioner",
    "volumeSnapshotClass": "atelier-snapshots"
  }
}
```
