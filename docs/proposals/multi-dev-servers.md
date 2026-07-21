# Multi Dev Servers

Status: **proposal — agreed design, not yet implemented**

Recap of the design discussion following the dev-tool refactor (`81dc6cb` — "Collapse
dev commands into a single dev tool"). Three features:

1. Bring back **multiple dev commands per workspace** (lost in the refactor, required for monorepos) — incl. **headless** entries and a **service-discovery env contract** for SPA cross-app URLs
2. **`dev-{name}-{id}` hostname routing** for declared entries (one public URL per command) + **`/proxy/{port}`** as the ad-hoc escape hatch
3. **Auto port discovery** — the sandbox UI lists every port the VM is listening on, each reachable through `/proxy/{port}`

Reference workload: the **frak-wallet** monorepo (§6) — SST-multiplexed dev with an
SSR-less SPA fleet, a backend, and a GCP tunnel.

---

## 1. Background

### What the refactor did

`81dc6cb` replaced the legacy `devCommands[]` surface (name, command, port, extraPorts,
workdir, env, isDefault — plus ~1400 lines of parallel infrastructure: `dev.routes.ts`,
agent `dev.rs`/`RUNNING_DEV_COMMANDS`, dynamic ingress builders, 5 `AgentClient.dev*`
methods) with a single `WorkspaceConfig.dev = { command, workdir?, env? }` riding the
generic **services rail**: the dev server is one lazy entry in `BUILTIN_TOOLS`
(`apps/manager/src/orchestrators/tools/registry.ts`), started/stopped/logged through the
same agent process manager as vscode/opencode/browser.

That was the right move — but it capped workspaces at **one** dev command.
`resolveDevConfig()` (`apps/manager/src/schemas/workspace.ts`) migrates legacy blobs by
picking the default entry and **dropping the rest**. The data is still in existing
workspace blobs; multi-dev support recovers all of it.

### How dev traffic flows today

```
browser ──HTTPS──▶ nginx ingress          dev-{id}.domain, TLS, host-based routing
                      │
                      ▼
              K8s Service port 3001       config.ports.dev, static SANDBOX_PORTS
                      │
                      ▼
              in-pod agent forwarder      forwarder.rs — pure L4 TCP splice
                      │                   (websockets/HMR pass through untouched)
                      ▼
              127.0.0.1:5173              config.ports.devApp — where the dev
                                          server binds, told via injected $PORT
```

Key properties to preserve:

- **No port declaration.** The platform injects `PORT` (and
  `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`); the app binds it. Deterministic,
  no detection races, same convention as Heroku/Cloud Run.
- **Static K8s objects.** `SANDBOX_PORTS` is fixed; ingresses are pre-registered at
  spawn (an ingress with no backend just 502s). No dynamic ingress lifecycle.
- **Generic rails.** start/stop/status/logs are the plain `services` API; the forwarder
  is 65 lines; the MCP dev tools are thin wrappers.

---

## 2. Feature: multiple dev entries

### Schema

`WorkspaceConfig.devs?: DevEntry[] | null` (max **6 exposed** entries — bounded by the
static port pool; headless entries don't count):

```ts
DevEntry = {
  name:     string,   // ^[a-z0-9-]{1,20}$ — slot id, URL label, service suffix
  command:  string,
  workdir?: string,   // defaults to first repo
  env?:     Record<string, string>,
  expose?:  boolean,  // default true. false = headless: process lifecycle
                      // (start/stop/logs/restart) but no port slot, no $PORT,
                      // no ingress/URL. For tunnels, workers, watchers.
}
```

- **No `port` field.** Each exposed entry gets `$PORT` injected, exactly like today.
- **Array order matters**: the first **exposed** entry is the default dev server
  (replaces the old `isDefault` flag).
- `null` keeps the existing "explicitly cleared" semantics (vs `undefined` = unset,
  fall through to legacy).
- **Headless entries** (`expose: false`) exist because real dev stacks include
  processes that need lifecycle management but no URL — e.g. a DB bastion tunnel the
  backend reaches over in-pod localhost (see the frak-wallet case study, §6).

`resolveDevEntries(config)` supersedes `resolveDevConfig()`:

| Stored config            | Resolved entries                                   |
|--------------------------|----------------------------------------------------|
| `devs` present           | as-is                                              |
| `devs === null`          | none (explicitly cleared)                          |
| legacy `dev` object      | `[{ name: "dev", ...dev }]`                        |
| legacy `devCommands[]`   | **all** entries (default first) — no data loss     |

### Ports — static pool, one pair per exposed slot

Exposed slot `i` (0-based, array order skipping headless entries) uses
`config.ports.dev + i` (public/forwarder listen) and `config.ports.devApp + i`
(app bind, injected as `PORT`). Defaults:

| Slot | Service     | Public port | App port (`$PORT`) | URL                       |
|------|-------------|-------------|--------------------|----------------------------|
| 0    | `dev`       | 3001        | 5173               | `dev-{id}.domain`          |
| 1    | `dev-{name}`| 3002        | 5174               | `dev-{name}-{id}.domain`   |
| 2    | `dev-{name}`| 3003        | 5175               | `dev-{name}-{id}.domain`   |
| 3–5  | `dev-{name}`| 3004–3006   | 5176–5178          | `dev-{name}-{id}.domain`   |

Headless entries get a `dev-{name}` service with **no** slot, no `PORT`, no forwarder,
no ingress.

- `SANDBOX_PORTS` (`kube.resources.ts`) gains the five extra pairs **unconditionally**
  — containerPort/Service-port declarations cost nothing, and the "ports are static"
  invariant holds.
- Slot 0 keeps the bare `dev` service name and `dev-{id}` URL: stable `routes.dev`,
  unchanged MCP default, back-compatible with existing sandboxes.
- Six slots is sized from the frak-wallet case (4 exposed apps today, headroom for 2).

### URLs and certificates

`dev-{name}-{id}` is a single DNS label under the wildcard cert
(`*.domain` covers one label — `{port}.{sub}.domain` schemes do not fit).
Length is safe: `dev-` (4) + name (≤20) + `-` (1) + sandboxId (12) = ≤37 < 63.

Named ingresses are built **at spawn from workspace config** (same pre-registration
behavior as every tool ingress). Renaming an entry changes the URL for sandboxes
spawned afterwards.

### Tools registry

Dev **stays in `BUILTIN_TOOLS`** (decided against extracting it: the registry rails —
exposure → ingress, `autoStartServices`, lazy start — are exactly what we want, and a
parallel dev-only subsystem is what the refactor deleted). The dev entry becomes
workspace-aware:

- `ToolContext.dev` → `ToolContext.devs: ResolvedDevEntry[]` (name + slot ports +
  expose flag).
- `buildServices` emits one service per entry. Injected env (user env first, contract
  overrides last — a user-set `PORT` must not break the forwarder):
  - exposed entries: `PORT`, `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`
  - **all** entries: `ATELIER_SANDBOX_ID`, `ATELIER_MANAGER_INTERNAL_URL` — so any dev
    process can fetch `/.well-known/atelier.json` and discover its siblings' public
    URLs without per-workspace env plumbing (the well-known IP guard already accepts
    in-sandbox callers). This is the **service-discovery contract** SPA builds rely on
    (§6).
- Exposure/ingress/`listToolInfos` for the dev tool expand per resolved entry;
  `tools.routes.ts` already special-cases dev for gating, this generalizes that.

### Agent

`SandboxConfig.devForwarder` → `devForwarders: Array<{ publicPort, appPort }>`
(singular field kept as fallback for pre-existing config blobs). `main.rs` spawns one
`forwarder::run(listen, target)` task per pair — the forwarder itself is untouched.

The process manager needs nothing: it is already generic over named services
(process-group kill, stop grace, restart sweep, `GET /services/:name/logs`).

### Manager API / MCP / well-known

- MCP `get_dev_server` / `manage_dev_server` / `get_dev_server_logs`
  (`mcp/tools/dev-server.ts`): optional `name` param, defaulting to the first entry.
  Service resolution: `name === entries[0].name ? "dev" : `dev-${name}``.
- `/.well-known/atelier.json`: `routes.dev` unchanged (string, default exposed entry —
  keeps every value under `routes` a flat string); add
  `routes.devServers: { [name]: url }` listing **all** exposed entries (default
  included, under its name). Consumers needing a specific sibling read
  `devServers[name]`; consumers wanting "the" dev URL read `dev`.
  Note: frak-wallet's speculative `packages/dev-tooling/src/sandbox.ts` guessed
  `routes.dev.{named,default}` (nested) — it adapts to this flat contract (unreleased,
  3-line change).
- `generateSandboxMd`: list all entries with their URLs (and the well-known env
  contract, so in-sandbox agents know sibling URLs are discoverable).

### Dashboard

- **Workspace form** (`workspace-form/dev-commands-form.tsx`): back to a small list —
  name + command + workdir + expose toggle per row, add/remove, max 6 exposed. Helper
  text keeps the `$PORT` contract note and mentions `/proxy/{port}` (see below).
- **Dev panel / sandbox card**: iterate entries — per-entry URL (exposed only), status,
  start/stop, logs (all existing per-service queries, keyed by service name).

### Monorepos: split per entry, no `extraPorts`

One entry = one command = one port = one URL. A turborepo workspace declares:

```
web:  turbo dev --filter=web
api:  turbo dev --filter=api
```

rather than one `turbo dev` opening two ports. The single-process-multi-port case
(e.g. `supabase start`) is **not** first-class — those ports are covered by
`/proxy/{port}` and port discovery instead. Re-adding per-entry `extraPorts` with
dynamic ingresses was considered and rejected (it resurrects the deleted machinery).

---

## 3. Routing model: declared vs ad-hoc

Two complementary surfaces, deliberately different:

| | `dev-{name}-{id}.domain` | `vscode-{id}.domain/proxy/{port}/` |
|---|---|---|
| Source | declared `DevEntry` | any port, zero declaration |
| Auth | public (shareable: demos, task links, MCP) | behind vscode forward-auth (developer-only) |
| Stability | stable across restarts (`$PORT` contract) | follows whatever binds the port |
| Transport | ingress → L4 forwarder (HMR/WS transparent) | code-server L7 proxy |
| Lifecycle | ingress pre-created at spawn | nothing to create |

### Why not `dev-{id}.domain:{PORT}`?

All sandboxes share one ingress IP; routing needs the sandbox id, which only exists in
the Host header / SNI at L7. K8s Ingress is 80/443-only; nginx `tcp-services` maps one
static edge port to one backend globally (no per-sandbox fan-out at L4); arbitrary edge
ports would need firewall openings beyond the chart's 80/443/2222 contract and are
routinely blocked by client networks. This is why every comparable product encodes the
port in the **hostname**: Codespaces (`{name}-{port}.app.github.dev`), Gitpod
(`{port}-{ws}.gitpod.io`), VS Code tunnels (`{tunnel}-{port}.devtunnels.ms`),
code-server subdomain mode (`{port}.{domain}`). Our scheme is the same pattern with a
name instead of a number — numbers-in-hostname (code-server's subdomain mode) would
need two labels under the wildcard cert, which it doesn't cover.

### `/proxy/{port}` — already shipped

The vscode tool **is** code-server, whose built-in path proxy is enabled by default:

- `https://vscode-{id}.domain/proxy/{port}/` → `127.0.0.1:{port}` in the sandbox
- `/absproxy/{port}` for apps that can't handle a base path (note: asset-heavy dev
  servers like Vite need their base path set to work under `/proxy`)
- Inherits vscode's forward-auth — authenticated developers only

Non-HTTP ports (postgres, redis) have the SSH hatch:
`ssh -L 5432:localhost:5432 sandbox-{id}@host -p 2222` via sshpiper. (VS Code
Remote-SSH users additionally get the client's own auto-forwarded Ports panel — that
mechanism multiplexes over the SSH channel itself and needs nothing from us.)

---

## 4. Feature: auto port discovery

Detection is cheap; it's **routing** to detected ports that's expensive (dynamic
ingress lifecycle or a catch-all Host-routing data plane). So: **detect and display,
route through what already exists** — `/proxy/{port}`. Zero edge/ingress machinery.

### Agent

`GET /ports` on the in-pod agent:

- Parse `/proc/net/tcp` + `/proc/net/tcp6`, keep `LISTEN` (state `0A`), dedupe
  v4/v6-mapped.
- Subtract infra ports: agent (9998), vscode, opencode, browser, terminal, sshd (22),
  and the dev forwarder listen ports (slots 0–3) — but **keep** the dev app ports, so
  a running dev server shows up like any other process.
- Response: `{ ports: [{ port, address }] }`. No process attribution (would need
  `/proc/*/fd` scanning as root; not worth it for v1).
- ~100 lines of Rust, no new dependencies, fits the raw-Hyper router.

### Manager

- `AgentClient.listeningPorts(sandboxId)` + `GET /api/sandboxes/:id/ports`
  (running sandboxes only). On-demand polling from the UI — no push, no cron.

### Dashboard

Small section in the sandbox drawer/card:

> **Listening ports:** `4000` `5432` `6379` — available via `/proxy/{port}`

- Each chip links to `https://vscode-{id}.domain/proxy/{port}/` (deep link), with a
  copy button for the URL.
- Non-HTTP services will render garbage through the proxy — that's fine; the list
  itself is the value (it answers "what did my command actually start?").
- Refresh button rather than polling interval.

### Explicitly out of scope (and why)

- **Click-to-expose public URLs for detected ports** — requires dynamic ingress
  create/delete/restart-sweep (the machinery `81dc6cb` deleted) or an always-on
  catch-all proxy in the websocket hot path. Revisit only with a concrete need.
- **Detection-driven dev URLs** — pure detection makes the public URL follow wherever
  the app happens to bind (Vite silently moves 5173→5174 when busy); `$PORT` injection
  keeps `routes.dev` deterministic for tasks/MCP. Detection complements, never drives,
  routing.

---

## 5. Implementation surface

| Area | File(s) | Change |
|---|---|---|
| Workspace schema | `manager/src/schemas/workspace.ts` | `DevEntrySchema` (incl. `expose`), `devs` field, `resolveDevEntries()` w/ full legacy migration |
| Sandbox config | `packages/shared/src/sandbox-config.schema.ts`, `manager/src/orchestrators/sandbox-config.ts` | `devForwarders[]` (keep `devForwarder` fallback), build N service entries, inject `ATELIER_SANDBOX_ID` / `ATELIER_MANAGER_INTERNAL_URL` |
| Tools registry | `manager/src/orchestrators/tools/registry.ts` | `ToolContext.devs`, per-entry services/exposures/URLs, headless handling |
| K8s | `manager/src/infrastructure/kubernetes/kube.resources.ts` | +5 static port pairs; named dev ingresses at spawn |
| Tool routes | `manager/src/api/sandboxes/tools.routes.ts` | per-entry dev gating |
| Agent | `agent-rust/src/config.rs`, `main.rs` | `dev_forwarders` parsing, spawn N forwarder tasks |
| Agent ports | `agent-rust/src/routes/` | `GET /ports` (`/proc/net/tcp` scan) |
| Manager ports | `infrastructure/agent/agent.client.ts`, `api/sandboxes/` | `listeningPorts`, `GET /:id/ports` |
| MCP | `manager/src/mcp/tools/dev-server.ts` | optional `name` param on the 3 tools |
| Well-known | `manager/src/api/internal-well-known.routes.ts` | `routes.devServers` map |
| Dashboard | `workspace-form/dev-commands-form.tsx`, `dev-commands-panel.tsx`, `sandbox-card.tsx`, drawer | entry list form (expose toggle), per-entry panel, ports section |
| Shared config | `packages/shared/src/config.schema.ts` | document `ports.dev`/`ports.devApp` as base of a 6-slot range |
| Docs | `README.md`, `packages/shared/schemas/*` (regenerate) | feature copy + schema examples |
| frak-wallet (consumer) | `packages/dev-tooling/src/sandbox.ts` | adapt to flat `routes.dev` + `routes.devServers` contract |

---

## 6. Case study: frak-wallet (primary use case)

The frak-wallet monorepo is the design's reference workload. Its dev stack is SST
multiplexing (`bun sst dev`): backend (Elysia), three Vite SPAs (wallet, listener,
business), a GCP bastion tunnel (postgres → `localhost:8888`, sqld → `8089`,
rustfs → `9100`), plus Pulumi infra watching.

### What can and cannot run in a sandbox

`sst dev` itself cannot (AWS/GCP credentials, Pulumi providers, infra watch). But the
repo already ships sandbox-ready pieces:

- **`dev:sandbox` scripts** per app — `vite dev --host`, backend `dev:watch` — designed
  to run without SST.
- **`env:sandbox` DevCommand** → writes `.env.sandbox` with all resolved
  secrets/resource values from a real dev machine. Natural payload for a workspace
  `fileSecret`; init command sources it.
- **`packages/dev-tooling/src/sandbox.ts`** — already fetches
  `/.well-known/atelier.json` via `ATELIER_SANDBOX_ID` /
  `ATELIER_MANAGER_INTERNAL_URL` and expects a named dev-URL map. Written
  speculatively against this proposal; the vite configs consume it
  (`sandboxEnv.backendUrl ?? getSstResource("BACKEND_URL") ?? prod-fallback`).

### The SPA problem this design must solve

The wallet apps are SSR-less: `BACKEND_URL` etc. are baked into the JS bundle by Vite
`define` at dev-serve time, and the **end-user's browser** (outside the sandbox) makes
the API calls. Any `localhost:*` value is dead on arrival — pointing at the *user's*
machine, not the sandbox. Cross-app links (wallet ↔ listener ↔ business) have the same
shape.

Resolution chain with this proposal:

1. Workspace declares named entries → each app has a **deterministic public sibling
   URL** (`dev-wallet-backend-{id}.domain`, …) known *before* anything starts.
2. Every dev service gets `ATELIER_SANDBOX_ID` + `ATELIER_MANAGER_INTERNAL_URL`
   injected → at Vite startup, `getSandboxEnv()` fetches the well-known and bakes the
   sibling URLs into the bundle.
3. Browser hits `https://dev-wallet-{id}.domain` → all baked URLs are public siblings →
   everything routes through the ingress. No localhost anywhere in the bundle.

### Workspace config sketch

| Entry | Command (workdir) | Expose |
|---|---|---|
| `wallet` | `bun run dev:sandbox -- --port $PORT` (`apps/wallet`) | ✅ default |
| `wallet-backend` | `bun run dev:sandbox` (`services/backend`) | ✅ (Elysia binds `process.env.PORT ?? 3030`) |
| `listener` | `bun run dev:sandbox -- --port $PORT` (`apps/listener`) | ✅ |
| `business` | `bun run dev:sandbox -- --port $PORT` (`apps/business`) | ✅ |
| `gcp-tunnel` | `bash ./infra/gcp-tunnel.sh` + env (repo root) | ❌ headless |

Notes:

- **Vite ignores the `PORT` env var** — the flag must be passed explicitly
  (`--port $PORT`). Elysia/Express/Next-style servers honor the env var. Worth a line
  in the dev form helper text.
- The tunnel is the canonical **headless** entry: backend reaches postgres/sqld/rustfs
  over in-pod localhost; tunnel crashes are restartable/loggable from the dashboard
  like any service. It needs the GCP credential in the sandbox (fileSecret) — that's a
  workspace-config concern, not a platform one.
- This workload is what sized the limits: 4 exposed + 1 headless today, 6 exposed
  slots for headroom.
