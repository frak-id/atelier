# Advanced Configuration

Atelier deploys only the server and console: plain Kubernetes manifests under
**`infra/k8s`** (Deployment, Service, Ingress, config ConfigMap, secrets, PVC,
RBAC, forward-auth and network policy). See
[`infra/k8s/README.md`](../infra/k8s/README.md) for the apply sequence.

Cluster infra (Kata runtime, cert-manager ClusterIssuer, TopoLVM and the
snapshot class, OCI registry, BuildKit) is installed separately and
referenced by name from the app config. See the
[Setup Guide](setup.md#prerequisites).

## How configuration is layered

Resolution order: environment variables, then the config file
(`ATELIER_CONFIG`, default `/etc/atelier/sandbox.config.json`), then built-in
defaults. The schema lives in `apps/server/src/config/config.schema.ts` and
the generated JSON Schema is `apps/server/schemas/atelier.config.schema.json`
(`bun run --filter @atelier/server generate-schema` regenerates it; a full
example is `apps/server/schemas/sandbox.config.full-example.json`).

**The config file is strict.** The server refuses to start when the file is
not valid JSON, is not an object, or contains a key the schema does not know.
The error names the keys, for example `Config file ... has unknown keys:
ports.terminal`. Environment variables are mapped by name and are not checked
for unknown names, so a stale env var is silently ignored.

Keys fall into two groups.

| Group | Set by | Console |
|-------|--------|---------|
| **Infrastructure** | The deployment: config file or env | Shown read-only on Settings > Config under "Set by deployment" |
| **Operational** | A server admin, from Settings > Config | Editable, unless the file or an env var sets the key (then it is locked and shows what locked it) |

Leave operational keys out of `30-config.yaml` so they stay editable. Setting
one there pins it. Stored overrides of an infrastructure key from an older
version are ignored.

## Config file

```jsonc
{
  "domain": {
    "baseDomain": "example.com",       // all tool hosts hang off this
    "dashboard": "atelier.example.com",
    "ssh": { "port": 2222, "hostname": "ssh.example.com", "listenPort": 2222, "upstreamUser": "dev" }
  },
  "auth": {
    "allowedOrg": "my-github-org",     // optional GitHub org gate
    "allowedUsers": [],                // optional username allow-list
    "defaultOrg": "my-team"            // slug of the team org, see below
  },
  "server": { "mode": "production", "port": 4000, "host": "0.0.0.0" },
  "runtime": { "backend": "kubernetes" },
  "kubernetes": {
    "namespace": "atelier-v2-sandboxes",
    "runtimeClass": "kata-atelier-clh-rs",
    "ingressClassName": "traefik",
    "toolIngressClusterIssuer": "letsencrypt-prod",
    "registryUrl": "zot.zot.svc:5000",
    "storageClass": "topolvm-thin",
    "volumeSnapshotClass": "atelier-snapshots",
    "vsCodeIngressAnnotations": { "traefik.ingress.kubernetes.io/router.middlewares": "<ns>-atelier-forward-auth@kubernetescrd" },
    "wakeIngressAnnotations": { "traefik.ingress.kubernetes.io/router.middlewares": "<ns>-atelier-wake@kubernetescrd" }
  },
  "imageBuilder": { "kind": "buildkit", "endpoint": "tcp://buildkitd.buildkit.svc:1234" }
}
```

Secrets (GitHub OAuth, JWT, secrets-at-rest key) come from env, injected from
the `atelier-v2-secrets` Secret, and override the file. The exact
`kubectl create secret` command is in `infra/k8s/README.md`.

### Infrastructure keys (deployment-set, read-only in the console)

| Key | Env var | Default |
|-----|---------|---------|
| `domain.baseDomain` | `ATELIER_BASE_DOMAIN` | `localhost` |
| `domain.dashboard` | `ATELIER_DASHBOARD_DOMAIN` | `sandbox.{baseDomain}` |
| `domain.ssh.port` | `ATELIER_SSH_PROXY_PORT` | `2222` (the port advertised in SSH URLs; on k3s it must equal the NodePort) |
| `domain.ssh.hostname` | `ATELIER_SSH_PROXY_HOSTNAME` | `ssh.{baseDomain}` |
| `domain.ssh.listenPort` | `ATELIER_SSH_LISTEN_PORT` | `2222` (what the in-server gateway binds) |
| `domain.ssh.upstreamUser` | `ATELIER_SSH_UPSTREAM_USER` | `dev` |
| `auth.github.clientId` / `clientSecret` | `ATELIER_GITHUB_CLIENT_ID` / `_SECRET` | empty (required in production) |
| `auth.jwtSecret` | `ATELIER_JWT_SECRET` | dev default (rejected in production) |
| `auth.allowedOrg` | `ATELIER_AUTH_ALLOWED_ORG` | unset |
| `auth.allowedUsers` | `ATELIER_AUTH_ALLOWED_USERS` | `[]` |
| `auth.defaultOrg` | `ATELIER_DEFAULT_ORG` | unset |
| `server.mode` | `ATELIER_SERVER_MODE` | `production` (`production` or `local`) |
| `server.port` / `server.host` | `ATELIER_SERVER_PORT` / `_HOST` | `4000` / `0.0.0.0` |
| `runtime.backend` | `ATELIER_RUNTIME_BACKEND` | `kubernetes` (or `docker`) |
| `ports.agent` | `ATELIER_AGENT_PORT` | `9998` |
| `kubernetes.namespace` | `ATELIER_K8S_NAMESPACE` | `atelier-sandboxes` |
| `kubernetes.kubeconfig` | `ATELIER_K8S_KUBECONFIG` | `/etc/rancher/k3s/k3s.yaml` (ignored in-cluster) |
| `kubernetes.runtimeClass` | `ATELIER_K8S_RUNTIME_CLASS` | `kata-atelier-clh-rs` |
| `kubernetes.ingressClassName` | `ATELIER_K8S_INGRESS_CLASS` | empty |
| `kubernetes.toolIngressClusterIssuer` | `ATELIER_K8S_TOOL_INGRESS_ISSUER` | empty (no TLS on tool Ingresses) |
| `kubernetes.registryUrl` | `ATELIER_K8S_REGISTRY_URL` | empty (local Docker daemon) |
| `kubernetes.storageClass` | `ATELIER_K8S_STORAGE_CLASS` | empty (cluster default) |
| `kubernetes.volumeSnapshotClass` | `ATELIER_K8S_VOLUME_SNAPSHOT_CLASS` | empty (cluster default) |
| `kubernetes.vsCodeIngressAnnotations` | none (file only) | `{}`; put on every Ingress whose port has `auth: "forward"` |
| `kubernetes.wakeIngressAnnotations` | none (file only) | `{}`; put on public Ingresses without forward-auth (previews) so they resume a paused sandbox |
| `imageBuilder.*` (`kind`, `image`, `endpoint`, `dockerHost`, `platform`, `cacheRepo`, `insecureRegistry`, `tls.secretName`, `tls.serverName`) | `ATELIER_IMAGE_BUILDER_*` | `kind=docker` |
| `serviceAccounts` | none (file only; secrets from the env vars it names) | `[]`; see [Service accounts](service-accounts.md#declaring-service-accounts-in-the-config) |

`auth.defaultOrg` is the slug of the team org. Every user who passes the
GitHub gate joins it as `member` on first login, it is the default spawn org,
and its owners are the server admins (config, image builds, toolset publish,
prebuild delete, `/mcp/admin`). If the org does not exist at the first login,
that user creates it and owns it. **If it is unset, every user is a server
admin**, and a production server logs a warning at boot.

Both ingress annotation maps are read when an Ingress is created. Sandboxes
booted before a change keep their old Ingress until a pause and resume
re-applies it.

### Operational keys (editable by server admins)

| Key | Env var (locks the key) | Default |
|-----|-------------------------|---------|
| `sandbox.defaultImage` | `ATELIER_DEFAULT_IMAGE` | `dev-base` |
| `sandbox.agentImage` | `ATELIER_AGENT_IMAGE` | `ghcr.io/frak-id/sandbox-agent:<release>` |
| `sandbox.defaultVcpus` | `ATELIER_DEFAULT_VCPUS` | `2` |
| `sandbox.defaultMemoryMb` | `ATELIER_DEFAULT_MEMORY_MB` | `4096` |
| `kubernetes.defaultVolumeSize` | `ATELIER_K8S_DEFAULT_VOLUME_SIZE` | `10Gi` |
| `jobs.concurrency` | `ATELIER_JOBS_CONCURRENCY` | `4` (pooled build jobs at once) |
| `prebuild.gitTracking` | `ATELIER_PREBUILD_GIT_TRACKING` | `true` |
| `prebuild.pruneKeep` | `ATELIER_PREBUILD_PRUNE_KEEP` | `3` (superseded snapshots kept per recipe; the newest is always kept) |
| `snapshot.manualKeep` | `ATELIER_SNAPSHOT_MANUAL_KEEP` | `5` (manual snapshots kept per sandbox, never one something boots from) |
| `sandbox.idle.*` | `ATELIER_IDLE_*` | see [Pause idle sandboxes](#pause-idle-sandboxes) |

Env booleans accept `true`, `false`, `1` and `0`.

### Removed keys

A config file that still sets a removed key fails at startup. Delete it. Removed env vars are ignored without an error.

| Removed | Why |
|---------|-----|
| `ports.terminal`, `ATELIER_TERMINAL_PORT` | Terminals use the attach port |
| `domain.ssh.gateway`, `ATELIER_SSH_GATEWAY` | Only the in-server gateway remains |
| `storage.provider`, `ATELIER_STORAGE_PROVIDER` | One volume backend per runtime backend |
| `domain.tls`, `server.maxSandboxes`, `server.maxActiveTasks`, `kubernetes.systemNamespace`, `sandbox.git` | Never read by the server |
| `ATELIER_MCP_TOKEN`, `ATELIER_CLIPROXY_URL`, `ATELIER_CLIPROXY_API_KEY`, `ATELIER_INTEGRATION_*` | MCP authenticates with API keys and JWTs; CLIProxy and integrations are gone |

`ATELIER_SERVER_MODE=mock` and `runtime.backend: "local"` no longer exist.

## Other environment variables

| Variable | Description |
|----------|-------------|
| `ATELIER_CONFIG` | Config file path |
| `SANDBOX_SECRETS_KEY` | Encrypts secrets and stored GitHub tokens at rest. **Required in production**: the server refuses to start without it. Local mode warns and uses a public dev key. |
| `ATELIER_GITHUB_TOKEN` | Local mode: a GitHub token for private repo access and repo discovery |
| `DATA_DIR` | SQLite database and the log directory (`DATA_DIR/logs`) |
| `MIGRATIONS_DIR` | Drizzle migrations folder (set in the image) |
| `ATELIER_SEEDS_DIR` | Base-image seed contexts (set in the image) |
| `LOG_LEVEL` | Pino log level |

In production the server also writes `DATA_DIR/logs/server.log`, rotated at
20 MiB with two older files kept.

## MCP access

Agents authenticate to `/mcp` and `/mcp/admin` with `Authorization: Bearer`
and an `atl_` API key (Settings > API Keys) or a session token. There is no
shared MCP token. `/mcp/admin` admits server admins only. A key with the `mcp`
scope works on `/mcp` only. The tools are listed in the
[README](../README.md#mcp).

An agent shared by several people should use a
[service account](service-accounts.md), not a person's key: it then owns its
sandboxes and pushes with its own GitHub credential. Service accounts can be
declared in the config file (`serviceAccounts`, secrets from env vars).

## Resulting URL patterns

| Service | URL |
|---------|-----|
| Console | `{domain.dashboard}` |
| Tool or port | `{name}-{id}.{baseDomain}` (for example `sandbox-{id}` for VS Code, `browser-{id}`, `dev-{name}-{id}`) |

## Base images

Base images are seed builds (`dev-base`, `dev-cloud`, `dev-rust`,
`dev-browser`, `sandbox-agent`) or registered external refs. Custom Dockerfile
and zip builds were removed. A server admin builds a seed from Library >
Images, or `infra/k8s/deploy.sh` bootstraps them. With `imageBuilder.kind=docker`
(local mode) the server builds into the host daemon. With `kind=buildkit` an
`endpoint` is required, and a build runs as a one-shot Job that talks to that
daemon.

## Recipes

### Use a different OCI registry

Set `kubernetes.registryUrl` (in `infra/k8s/30-config.yaml`) to the registry's
`host:port`, with no scheme. A plain-HTTP registry must also be a mirror in
the node's `/etc/rancher/k3s/registries.yaml`.

### Pause idle sandboxes

The server pauses running sandboxes nobody uses (design:
[idle-autopause.md](idle-autopause.md)). The keys are operational: edit them
on Settings > Config, or pin them with their env var.

| Key | Env var | Default |
|-----|---------|---------|
| `sandbox.idle.mode` (`off`/`observe`/`enforce`) | `ATELIER_IDLE_MODE` | `observe` |
| `sandbox.idle.minutes` | `ATELIER_IDLE_MINUTES` | `120` |
| `sandbox.idle.network` | `ATELIER_IDLE_NETWORK` | `true` |
| `sandbox.idle.networkMinBytesPerMinute` | `ATELIER_IDLE_NETWORK_MIN_BYTES` | `65536` |
| `sandbox.idle.files` | `ATELIER_IDLE_FILES` | `true` |
| `sandbox.idle.cpu` | `ATELIER_IDLE_CPU` | `false` |
| `sandbox.idle.cpuMinMillicores` | `ATELIER_IDLE_CPU_MIN_MILLICORES` | `250` |
| `sandbox.idle.maxKeepAwakeHours` | `ATELIER_IDLE_MAX_KEEP_AWAKE_HOURS` | `24` |

Start in `observe`: every sandbox page shows when it would be paused and its
traffic per minute, so you can check the byte threshold against real idle tabs
before switching to `enforce`. Network and file signals need an agent that
serves `GET /activity`; a sandbox with an older agent is never paused while
those signals count. A paused sandbox wakes on access, see
[idle-autopause.md](idle-autopause.md#8-auto-resume).

### Enable prebuilds with TopoLVM

Create a `VolumeSnapshotClass` for the `topolvm.io` driver (see
[Setup > Storage and snapshots](setup.md#5-storage-and-snapshots-optional--required-for-prebuilds)),
then reference it and a Block-capable TopoLVM StorageClass:

```jsonc
// infra/k8s/30-config.yaml
{
  "kubernetes": {
    "storageClass": "topolvm-provisioner",
    "volumeSnapshotClass": "atelier-snapshots"
  }
}
```
