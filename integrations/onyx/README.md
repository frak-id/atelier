# Onyx on Atelier

[Onyx](https://github.com/onyx-dot-app/onyx) (formerly Danswer, MIT Community
Edition) is Atelier's company knowledge platform: it indexes GitHub, Slack,
Linear, Notion (and optionally Gmail), answers questions with citations, and
exposes both a chat agent and an MCP server. This directory is the config-as-
code for running it on the `hetzner-atelier` k3s cluster. See
`docs/proposals/company-knowledge.md` for the why/decision record this
implements.

Everything here is CE-only, no per-user permissions: every source is indexed
public (`access_type = "public"` throughout `terraform/`), matching CE's
default "Basic" group giving every logged-in user uniform access — see
"Known limitations: no RBAC in CE" below.

## Architecture

```
 GitHub (issues+PRs)   Slack (public chans,   Linear   Notion   Gmail (off)
        │                last N months)         │        │        │
        ▼                     ▼                 ▼        ▼        ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │                    Onyx (this Helm release)                     │
   │  api / webserver / model-servers (embed: nomic-embed, CPU) /    │
   │  celery workers / Postgres / Redis / MinIO / OpenSearch          │
   │                                                                   │
   │  MCP server (8090) ── search_indexed_documents, open_urls  ◄─────┼── opencode / Claude Code / pi
   │                                                                   │   in Atelier sandboxes, Open-Inspect
   │  Agent "Atelier" (featured, public) ── default LLM: claude-sonnet-5
   │        │ tools: launchpad_catalog/launch/workspaces/workspace     │
   │        ▼                                                          │
   │  onyx_mcp_server "Atelier" (PER_USER) ─────────────────────────────┼──► Atelier /mcp
   │                                                                   │    (each user's own atl_ key)
   │  Document set "codebase-wiki" ◄── POST /onyx-api/ingestion ───────┼──► CodeWiki CronJob (ns onyx, see
   │                                                                   │    integrations/codewiki/)
   └─────────────────────────────────────────────────────────────────┘
        │ LLM calls (chat, no embeddings)
        ▼
 http://atelier-cliproxy.atelier-system.svc.cluster.local:8317/v1
 (OpenAI-compatible; model claude-sonnet-5, configurable)

 Ingress: onyx.hetzner-staging.frak.id (Traefik, cert-manager
 letsencrypt-frak) — see helm/values.yaml for why this isn't the chart's own
 `ingress.enabled: true`.
```

## Resource budget

The chart's own defaults sum to roughly 6-8 CPU / 16-20Gi *requests* across
api + webserver + both model-servers + OpenSearch + ~9 celery worker
Deployments (arithmetic over the chart's own per-component resource
defaults in
[values.yaml](https://github.com/onyx-dot-app/onyx/blob/main/deployment/helm/charts/onyx/values.yaml);
see `docs/research/company-knowledge-tools.md` for the full "small company"
sizing rationale). `helm/values.yaml` trims the pieces that scale
with corpus size / traffic for a small company (~1-20 users, matching Onyx's
own "Small" hardware tier):

| Component | Chart default | This deployment |
|---|---|---|
| OpenSearch requests/limits | 2/4Gi → 4/8Gi CPU/mem | 1/2Gi → 2/4Gi |
| OpenSearch heap (`opensearchJavaOpts`) | `-Xmx4g -Xms4g` | `-Xmx2g -Xms2g` (kept at 50% of the limit above) |
| OpenSearch persistence | 64Gi | 30Gi |
| Postgres persistence | 10Gi | 20Gi (headroom for chat history / usage ledger) |
| MinIO persistence | 30Gi | 20Gi |
| Inference model-server | 1/3Gi → 4/10Gi | 0.5/2Gi → 2/6Gi |
| Index model-server | 1/3Gi → 6/6Gi | 0.5/2Gi → 2/4Gi |
| Celery workers, Postgres/Redis/MinIO topology | — | left at chart default |
| Code Interpreter (Craft) | on | **off** (`codeInterpreter.enabled: false`) |
| bundled `nginx` (ingress-nginx) | on | **off** — Traefik already fronts the cluster |
| Slack bot (live @-mentions) | on | **off** — a different feature from the Slack indexing connector |

## Setup

1. **Secrets.** Export these env vars before running `deploy.sh` (it fails
   with a clear message if any are missing):
   ```sh
   export ONYX_POSTGRES_PASSWORD=$(openssl rand -hex 24)
   export ONYX_REDIS_PASSWORD=$(openssl rand -hex 24)
   export ONYX_MINIO_ROOT_USER=onyx
   export ONYX_MINIO_ROOT_PASSWORD=$(openssl rand -hex 24)
   export ONYX_OPENSEARCH_ADMIN_PASSWORD='Ch4nge-Me!Aa1'   # must meet OpenSearch's complexity rules
   export ONYX_USER_AUTH_SECRET=$(openssl rand -hex 32)
   ```
2. **Deploy:**
   ```sh
   integrations/onyx/deploy.sh              # creates the 5 secrets above, helm upgrade --install
   integrations/onyx/deploy.sh --dry-run    # helm template only, no cluster writes
   ```
3. **First admin signup.** Visit `https://onyx.hetzner-staging.frak.id` and
   sign up — Onyx makes the **first user an Admin automatically**, no
   config needed.
4. **Bootstrap Terraform's own API key by hand.** Settings → API Keys →
   create a key (it will be Admin-capable — CE has no group-scoped
   restriction, see "Known limitations" below). This is the one manual,
   out-of-band secret Terraform needs (`onyx_api_key` variable) — the
   `onyx_api_key` Terraform resource itself has this exact chicken-and-egg
   documented ("the key the provider itself authenticates with must be
   created out-of-band").
5. **`terraform apply`:**
   ```sh
   cd integrations/onyx/terraform
   cp terraform.tfvars.example terraform.tfvars   # fill in real values, never commit it
   terraform init
   terraform apply
   ```
   This creates: the cliproxy LLM provider + default model, one cc_pair per
   source secret you provided (GitHub/Slack/Linear/Notion/Gmail), the
   codebase-wiki ingestion target + document set, the Atelier MCP server
   registration, the featured "Atelier" agent, and the `wiki-sync-job` /
   `agents-mcp` API keys (outputs, sensitive — `terraform output
   wiki_sync_api_key` / `terraform output agents_api_key`).
6. **Per-source manual prerequisites** (each connector is gated on its
   secret being non-empty in `terraform.tfvars` — no secret, no connector):

   - **GitHub**: a fine-grained PAT scoped to the repos you list in
     `github_repos`, with repository permissions **Contents: Read, Issues:
     Read, Pull requests: Read, Metadata: Read**. `include_files = false` —
     code itself is indexed through the codebase wiki (`wiki.tf`), not raw
     GitHub file contents.
   - **Slack**: create a Slack app from this manifest (App settings →
     Create New App → From a manifest). It grants **only public-channel
     scopes** — no `groups:*` — so the bot literally cannot see private
     channels, which is how "public channels only" is enforced (Onyx's
     connector itself has no such filter):
     ```yaml
     display_information:
       name: Onyx (Atelier company knowledge)
     oauth_config:
       scopes:
         bot:
           - channels:history
           - channels:read
           - users:read
     settings:
       org_deploy_enabled: false
       socket_mode_enabled: false
       token_rotation_enabled: false
     ```
     Install it to the workspace, invite the bot to every public channel you
     want indexed (or set `slack_channels = []` to index every public
     channel it can see), and put the `xoxb-...` bot token in
     `slack_bot_token`.
   - **Linear**: a personal API key (Linear → Settings → API → Personal API
     keys) in `linear_api_key`.
   - **Notion**: create an internal integration
     (notion.so/my-integrations), then **share** each page/database you want
     indexed with it (Notion integrations see nothing until pages are
     explicitly shared). Put the integration token in `notion_token`; set
     `notion_root_page_id` to restrict indexing to one subtree, or leave it
     empty to index everything the integration can see.
   - **Gmail** (optional, off by default — `gmail_enabled = false`): a
     Google Cloud service account with **domain-wide delegation** for the
     Gmail read scope, impersonating one mailbox
     (`gmail_primary_admin_email`). The exact `credential_json` key names in
     `connectors.tf` are a best-effort shape (unverified against
     [`backend/onyx/connectors/gmail/connector.py`'s `get_google_creds()`](https://github.com/onyx-dot-app/onyx/blob/main/backend/onyx/connectors/gmail/connector.py)
     for the deployed image tag) — confirm before relying on this in
     production. See `docs/research/company-knowledge-tools.md` for the
     research trail.
7. **Monthly apply for the Slack window — schedule a CI cron, there is no
   in-cluster CronJob for this.** `terraform/slack.tf`'s
   `time_rotating.slack_window` (1-month rotation) only advances its
   timestamp — and therefore only forces the Slack connector/cc_pair replace
   that deletes-and-backfills the rolling window — when a `terraform apply`
   actually runs after the rotation period elapses. This repo does not ship
   a Kubernetes CronJob for it (Terraform state/credentials don't belong in
   the cluster it manages); add a monthly scheduled job in your CI system
   (e.g. a GitHub Actions `schedule` trigger) that runs
   `terraform apply -auto-approve` in `integrations/onyx/terraform/` against
   the same `terraform.tfvars`/state, or it silently never rotates. See the
   long comment at the top of `slack.tf` for why this mechanism (not
   `indexing_start` alone, not pruning) is the correct one.
8. **Onyx MCP for sandboxes / Open-Inspect.** `helm/values.yaml` sets
   `mcpServer.enabled: true`, exposed at
   `https://onyx.hetzner-staging.frak.id/mcp` (Streamable HTTP). Each client
   needs a Bearer token — either the `agents-mcp` API key
   (`terraform output agents_api_key`, read/search-only in intent though see
   "Known limitations: no RBAC in CE") or a personal Onyx PAT for a
   human-scoped identity. Config:
   - **opencode** (`opencode.json` / project config):
     ```json
     {
       "mcp": {
         "onyx": {
           "type": "remote",
           "url": "https://onyx.hetzner-staging.frak.id/mcp",
           "headers": { "Authorization": "Bearer <token>" }
         }
       }
     }
     ```
   - **Claude Code**: `claude mcp add --transport http onyx
     https://onyx.hetzner-staging.frak.id/mcp --header "Authorization:
     Bearer <token>"`, or the equivalent `.mcp.json` entry.
   - **pi**: same Streamable-HTTP MCP shape, URL + `Authorization: Bearer
     <token>` header, in whichever MCP-servers config pi reads.

   To wire this into an Atelier toolbox, add an MCP-server entry pointing at
   the URL/header above to the toolbox definition the sandbox image
   materializes at boot (see `packages/compose` for the toolbox/preset
   composition seam) — this integration does not itself own toolbox
   definitions, only the Onyx side of the MCP endpoint and its API key.
9. **The Atelier MCP action.** `terraform/atelier.tf` registers Atelier's
   `/mcp` endpoint as an `onyx_mcp_server` with `auth_performer = PER_USER`:
   Onyx stores no shared credential, each user must add their **own**
   Atelier API key (`atl_...`, from Atelier's console → Settings → API
   keys) once, from Onyx's UI (Settings → Actions → Atelier → "Connect").
   This is what keeps each user's Launchpad workspaces theirs — Onyx acts as
   that user against the Atelier API, not as a shared service account.

## Upgrades

Chart version (`deploy.sh`'s `CHART_VERSION`) and image tag
(`helm/values.yaml`'s `global.version`) **must move together** — the chart's
own values.yaml documents a hard compatibility coupling: chart ≥ 0.7.0 pairs
with the distroless, non-root (UID 1001) model-server image, and mismatching
either direction crash-loops (`update-ca-certificates` needs a shell the new
image doesn't have; the old image can't be written by UID 1001). Currently
pinned: chart **0.8.38**, image **v4.8.1** (latest non-beta
[GitHub release](https://github.com/onyx-dot-app/onyx/releases) as of
2026-09-28 — re-check both before every upgrade, chart releases move almost
daily).

## Codebase wiki

The "Document set 'codebase-wiki'" box in the architecture diagram above is
fed by `integrations/codewiki/` (a separate integration, built alongside
this one) — a Kubernetes `CronJob` in the `onyx` namespace that runs
[CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki) against Atelier's own
repo(s) and pushes the generated pages through Onyx's Ingestion API
(`POST /onyx-api/ingestion`) into `onyx_cc_pair.wiki_ingestion`
(`terraform/wiki.tf`) — see `docs/research/company-knowledge-tools.md` for
why CodeWiki and not one of the other self-hosted wiki generators evaluated.

That job authenticates as the `wiki_sync_api_key` output
(`terraform/api_keys.tf`'s `onyx_api_key.wiki_sync`) and needs three values
to build its ingestion requests, which map onto this integration's Terraform
outputs as follows:

| CodeWiki job secret key | Value | Source |
|---|---|---|
| `ONYX_API_KEY` | the raw key | `terraform output -raw wiki_sync_api_key` (sensitive, only ever returned once at creation — store it in a k8s Secret at apply time, don't re-derive it) |
| `ONYX_CC_PAIR_ID` | the ingestion target's cc_pair id | `terraform output wiki_cc_pair_id` (`onyx_cc_pair.wiki_ingestion.id`) |
| `ONYX_URL` | the in-cluster API service, **not** the public ingress host | `http://onyx-api-service.onyx.svc.cluster.local:8080` |

`ONYX_URL` is the in-cluster `Service` the chart renders for the `api`
Deployment (confirmed by rendering the chart: `helm template onyx onyx/onyx
--version 0.8.38 -n onyx -f helm/values.yaml ... | grep -A5 'name: onyx-api-service'`,
or `integrations/onyx/deploy.sh --dry-run`, which runs the same `helm
template`) — service name `onyx-api-service`, namespace `onyx`, port `8080`.
Unlike the public ingress (`helm/values.yaml`'s `extraManifests`, which
routes `/api` and strips it before the backend), calls from inside the
cluster hit the API Service directly, so **no `/api` path prefix** is
needed: `POST http://onyx-api-service.onyx.svc.cluster.local:8080/onyx-api/ingestion`.

This integration owns the Onyx side (the ingestion target, its document set,
and the API key); `integrations/codewiki/` owns the CronJob, the CodeWiki
config pointed at cliproxy, and the secret assembled from the table above.

## Known limitations

- **CPU embedding throughput** ([onyx-dot-app/onyx#8396](https://github.com/onyx-dot-app/onyx/issues/8396)):
  the CPU-only embedding model server has a reported ~30-50x slowdown under
  concurrent load (unbounded default `ThreadPoolExecutor`). Fine for a small
  company's steady-state indexing; watch for indexing-watchdog trips if a
  large backfill (e.g. a fresh Slack/GitHub connector) runs concurrently
  with heavy chat traffic. Fix status on the pinned image tag was not
  re-verified — re-check the issue before scaling the corpus up
  significantly.
- **Slack window mechanics**: Onyx has no native rolling-retention connector
  option (`indexing_start` is a fixed timestamp; pruning re-lists all
  current history with no `start` bound — see the comment header in
  `terraform/slack.tf`). The `time_rotating` + force-replace mechanism here
  is the closest correct implementation given the provider/API surface as
  read on 2026-09-28, but it depends on a scheduled monthly `terraform
  apply` actually running (step 7 above) — a missed month just means the
  window doesn't shrink that month, not silent data loss.
- **Provider maturity (0.3.x)**: `onyx-dot-app/onyx` (Terraform provider) is
  young (latest `v0.3.0`). Several resources explicitly document drift blind
  spots (masked secrets never read back — `api_key`, `credential_json`,
  `custom_config`, MCP tokens; `onyx_cc_pair`'s `groups`/`auto_sync_options`/
  `processing_mode` not read back at all) — Terraform's state is
  authoritative for those fields, not the live server.
- **No RBAC in Community Edition**: `onyx_user_group` (and therefore
  group-scoping any resource's `groups`/`group_ids`) is Enterprise-only —
  every call 404s on CE. This is actually the intended shape for "everything
  public, no per-user permissions" (every `access_type = "public"`), but it
  also means the `wiki-sync-job` and `agents-mcp` API keys
  (`terraform/api_keys.tf`) cannot be meaningfully scoped down from full
  admin access on CE — see the comments there and in `variables.tf`.
- **MCP tool discovery is a live call, done via `hashicorp/http`, not the
  onyx provider**: the onyx provider's `onyx_mcp_server` resource only ever
  calls `POST /admin/mcp/servers/create`, which creates the server row and
  its auth config but never talks to the MCP server itself — discovering
  its tools is a separate backend call
  (`GET /admin/mcp/server/{id}/tools/snapshots?source=mcp`, per
  `backend/onyx/server/features/mcp/api.py`). `terraform/atelier.tf` makes
  that call directly (with `depends_on = [onyx_mcp_server.atelier]`) and
  also looks up the built-in Search tool's id from `GET /tool` (persona
  `tool_ids` has no implicit search — see the `PersonaUpsertRequest.tool_ids`
  comment "e.g. ID of SearchTool" in
  `backend/onyx/server/features/persona/models.py`). Both normally resolve
  on the first apply. They can still legitimately come back empty if
  Atelier's `/mcp` endpoint isn't yet reachable from the Onyx pod when
  discovery runs (DNS/ingress propagation) — `terraform apply` still
  succeeds in that case (the `http` data sources don't error on non-2xx
  responses), but the agent ends up with no Atelier tools; re-running
  `terraform apply` retries discovery. `var.atelier_tool_ids` /
  `var.atelier_search_tool_id` are the escape hatches if discovery is
  unreliable in your environment (see `variables.tf`) — this is a real,
  documented possibility, not an oversight.
- **Ingress deviates from the chart's own `ingress.enabled: true`** — see the
  long comment at the top of `helm/values.yaml` for why (nginx-only
  annotations + a hardcoded, nginx-solver-only `ClusterIssuer` name baked
  into the chart's templates, both incompatible with this Traefik-only
  cluster). Functionally equivalent (same host, same `letsencrypt-frak`
  issuer, same TLS), just rendered via `extraManifests` instead.
- **LLM provider type is unverified against a live cliproxy**
  (`llm_provider` defaults to `"openai"`, cliproxy's OpenAI-compatible
  surface) — the
  [Custom Inference Provider docs](https://docs.onyx.app/admins/ai_models/custom_inference_provider)
  and `docs/research/company-knowledge-tools.md` flag this as the safer
  default but not empirically tested; if `terraform apply` fails validating
  `onyx_llm_provider.cliproxy`, try `llm_provider = "anthropic"` against
  cliproxy's `/v1/messages` surface instead.

## Files

- `helm/values.yaml` — chart overrides (pinned version, trimmed resources,
  ingress/secrets wiring). `deploy.sh` — creates the chart's secrets from env
  vars and runs `helm upgrade --install` (or `--dry-run` → `helm template`).
- `terraform/` — `onyx-dot-app/onyx` (Terraform provider) config: LLM
  provider, connectors/cc_pairs per source, the Slack rolling window, the
  codebase-wiki ingestion target + document set, the Atelier MCP
  registration + featured agent, and the two managed API keys. See
  `terraform.tfvars.example` for every knob.
