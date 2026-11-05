# Atelier: Roadmap

What is left to do, grouped by kind. Closed items are listed at the end so the
history stays readable.

## Known gaps

Security and access:

- **Forward-auth is sign-in only.** A port with `auth: "forward"` lets any
  signed-in Atelier user through (`GET /auth/forward`,
  `infra/k8s/80-forward-auth.yaml`), not only members of the sandbox's org.
  Only the auto-resume branch checks sandbox access. The session cookie is
  scoped to the base domain, so a sandbox's own processes receive its
  visitors' session token. A per-host tool cookie would close that.
- **Previews are public.** A prebuild's dev-server ports skip forward-auth
  whatever they declare (`spawnSurface`), so preview links work without an
  Atelier account.
- **The wake endpoint needs no login.** `GET /auth/wake` resumes a paused
  sandbox for anyone who holds its preview URL. The id in the host is 12
  random characters, and the resume uses the owner's credentials.
- **Prebuilds are not caller-scoped.** Any authenticated user can list a
  prebuild or edit its dev servers. Deleting one needs a server admin.
- **`/v1/jobs` is not scoped to the caller.** Any authenticated user sees the
  whole feed.
- **A wrong `ATELIER_SERVER_MODE` is not fatal.** A value other than
  `production` or `local` (for example a leftover `mock`) is reported as a
  config warning, and the server then runs in neither mode: no auth bypass, no
  SSH gateway, and no secrets-key check. Startup should fail instead.
- **Agent WebSocket tokens travel in the URL** (`?token=`) because the
  server's relays dial bare URLs. Moving to a header means passing headers
  through `api/ws-relay.ts`, `sessions/acp/acp-stream.ts` and `runtime.attach`.
- **Sandbox egress is open.** The network policy restricts ingress only.

Agent tasks and MCP:

- **No PR URL on tasks.** Tasks store branch, head, commits ahead and diff
  stat. A `prUrl` needs the owner's GitHub token and the remote parsed.
- **`read_files` goes through `exec`.** The agent has no read endpoint, so each
  file is one shell command. It decodes UTF-8 text only and assumes a POSIX
  shell with `wc`, `sed` and `head`.
- **Create warnings are job-only.** The last-good prebuild fallback warning
  appears in the create job result and the console toast, not in the MCP
  `create_sandbox` result.
- **A snapshot or pause ref is not retrievable over MCP** when the operation
  outlives `waitSeconds`.
- **A create job that fails before its record exists** leaves `get_sandbox`
  answering `NOT_FOUND` with no reason once the job is no longer active.
- **Task cwd is a guess.** The console derives it from the first repo URL
  (`/home/dev/<repo>`); `SandboxRepo` carries no clone path.
- **Task rows of a destroyed sandbox** linger until the one-week prune.
- **Inbox "seen" state is per browser** (localStorage), and notifications work
  only while the tab is open.

Runtime and operations:

- **Snapshots cannot be named.** `POST /v1/sandboxes/:id/snapshot` takes no
  name.
- **A terminal does not close its WebSocket clients when the shell exits.**
- **The Docker backend cannot expose a port that was not declared at boot.**
- **Paused sandboxes keep their Service and Ingresses.** Boot re-applies them
  with a merge patch; this has not been verified on a live cluster.
- **Specs stored before the secrets change** still hold resolved values until
  their next resume. A one-off job could re-store them.
- **`kubernetes.defaultVolumeSize` is pinned** in the shipped ConfigMap, so it
  is locked in the console. Remove it from `30-config.yaml` to make it
  editable (the default becomes 10Gi).
- **The sandbox-agent image tag must exist** before a main build pulls it: the
  default `sandbox.agentImage` pins the release version, which `release.yml`
  publishes.

## Next

- **Onboarding.** A smoother first run for the console and for local mode, and
  an installer for the cluster path (a Helm chart for infra, server and
  console).
- **Examples in the console.** A dev companion for the product team, for
  instance.
- **Plugin system.** Slack and Linear connectors, Grafana and Alertmanager
  hooks, other git providers, a mission-control view. Could be hosted
  externally, since the API exists.

## Closed

- The original POC ("v1") is retired. The live cluster object names
  (`atelier-v2-*` namespaces, PVC, secrets, `:v2` image tags) keep their names:
  renaming them needs a migration.
- Docker backend and local mode: `docker-compose.local.yml`, `tar` toolset
  fallback, more filesystems.
- The host CLI, mock mode, Steery and the integrations framework, the
  permission and question APIs, custom Dockerfile and zip image builds, org
  policy, saved specs and the viewer and admin roles were removed.
- Agent authentication and sandbox network isolation (bearer token,
  `85-network-policy.yaml`).
- Auto-resume on access, pause-snapshot cleanup, snapshot retention, last-good
  prebuild fallback.
- Persisted agent tasks with a git result and a console inbox.
- The org model: default org, owner and member roles, org-owned toolboxes with
  files.
- MCP split into `/mcp` and `/mcp/admin`.
- Secrets stored as references, resolved at every boot; GitHub token encrypted.
- One config source per key, with the infrastructure and operational split.
