# @atelier/hub — company knowledge

The first slice of the company agent from
[`docs/research/company-agent-prior-art.md`](../../docs/research/company-agent-prior-art.md):
the **knowledge layer** every agent reads from and proposes to. It is a
separate deployable that talks to nothing in `apps/server`. The domain lives
in [`@atelier/knowledge`](../../packages/knowledge); this app is its HTTP,
MCP and webhook shell. Design and next steps:
[`docs/proposals/company-knowledge.md`](../../docs/proposals/company-knowledge.md).

```
 GitHub push ──▶ /webhooks/github ──▶ IndexRunner: fetch → indexRepository → applyIndex → embed
                                                              │
 agents (Atelier sandbox, Open-Inspect, your harness) ─▶ /mcp ┤  knowledge.db (sqlite)
 humans / console / scripts ────────────────────────▶ /api ──┘  memory · graph · docs · audit
```

## Run it

```sh
cp hub.config.example.json hub.config.json
bun run cli token                 # mint a token, paste its sha256 into the config
bun run dev                       # :4100

# Bootstrap from a local checkout instead of waiting for a push:
bun run cli index ../.. --repo frak-id/atelier
bun run cli search "sandbox pause resume"
```

Secrets come from the environment, never the config file:

| Variable | Use |
|---|---|
| `HUB_CONFIG` | Config path (default `./hub.config.json`) |
| `HUB_DATA_DIR`, `HUB_PORT` | Override the config |
| `HUB_WEBHOOK_SECRET` | Enables `/webhooks/github` (HMAC `X-Hub-Signature-256`) |
| `HUB_GIT_TOKEN` | Fetches private repos (a GitHub App installation token is ideal) |
| `HUB_EMBEDDINGS_API_KEY` | For `embeddings.provider: "openai-compatible"` |
| `HUB_LLM_API_KEY` | The hub's LLM (cliproxy client key), for codebase recaps |
| `HUB_LLM_BASE_URL`, `HUB_LLM_MODEL` | Override `llm.baseUrl` / `llm.model` |
| `HUB_SLACK_RETENTION_MONTHS` | Override `retention.slackMonths` |

Container image: `docker build --target hub .` (mount `/app/data` and
`/app/config/hub.config.json`). Includes a Node runtime + `pi` for recaps
(see below); everything else is Bun.

### Config reference

| Setting | Default | Notes |
|---|---|---|
| `llm.baseUrl` | the cluster's cliproxy | any Anthropic- or OpenAI-compatible endpoint |
| `llm.api` | `"anthropic-messages"` | or `"openai-completions"` |
| `llm.model` | `"claude-sonnet-5"` | used for recaps (and later, summaries) |
| `llm.thinking` | `"medium"` | `off` \| `minimal` \| `low` \| `medium` \| `high` |
| `retention.slackMonths` | `6` | **not used yet**: sizes the daily sweep the future Slack connector will run; kept here so the config shape is settled |
| `recaps.enabled` | `true` | globally; also needs `HUB_LLM_API_KEY` set |
| `recaps.piCommand` | `["pi"]` | argv prefix for the pi CLI |
| `recaps.concurrency` | `2` | areas recapped in parallel |
| `recaps.timeoutMinutes` | `20` | per pi invocation |
| `recaps.maxAreas` | `30` | upper bound a plan may declare |
| `repos[].recaps` | `true` | set `false` to opt a repo out |

`GET /api/config` (scope `review`) returns the effective config with
secrets replaced by booleans (`secretsSet.llmApiKey`, …).

### Codebase recaps

After every successful index run, if recaps are enabled for the repo and
`HUB_LLM_API_KEY` is set, a headless [`pi`](https://github.com/earendil-works/pi)
explores the checkout and writes/updates its recaps:

1. **Plan** (first run, force, or a push that touches files no area
   covers): pi is given a structural map (packages/crates, their internal
   deps, CODEOWNERS, top-level dirs) and returns the areas it wants —
   one for a small repo, one per app/package (or group of small packages)
   for a monorepo.
2. **Recap**: one pi run per area writes a markdown recap (purpose,
   architecture, key flows, entry points, conventions, gotchas,
   connections to other areas); a final tools-less run writes the repo
   overview from the areas' recaps.
3. **On push**: only the areas whose paths match the diff since their last
   recapped revision are regenerated, given their previous recap and the
   diff. A changed file that matches no area triggers a re-plan; a failed
   area keeps its previous recap and is retried next run.

Recaps are stored as documents (collection `recap:<owner/name>`, chunked
by `## ` heading) and as full bodies in `hub_recap_areas`. Read them with
`GET /api/recaps?repo=` (areas + overview status), `GET
/api/recaps/area?repo=&area=` (one area's body, or `area=overview`), or
the `codebase_recap` MCP tool. `bun run cli recap <dir> --repo o/n
[--force]` indexes and recaps a local checkout, like `cli index`.

**Security note**: pi runs with `read, grep, find, ls` only (never `bash`,
`write` or `edit`), a throwaway `$HOME`/config dir per run, and an
environment holding only `PATH`, `HOME`, `PI_CODING_AGENT_DIR`,
`PI_OFFLINE` and the LLM key — never the hub's own environment. It can
still read anything on the hub's filesystem the checkout directory allows
(mitigated by running it in its own dir), and redaction of known secrets
from its output is best-effort string matching, not a guarantee. Moving
the run into an Atelier sandbox built from the repo's prebuild is the
planned hardening (`docs/proposals/company-knowledge.md`).

## Access model

Company knowledge is readable by everyone who can call the hub: there are
no per-record permissions, audiences or reader lists. The only control
over what's visible is what gets ingested in the first place. Tokens carry
an **actor** and **scopes**:

- `read`: search, graph, active memories. `propose`: propose / flag memories
  (what agents get). `review`: the governance queue, audit log, and every
  memory. `index`: trigger re-indexing.
- Only humans approve, edit, restore, archive and erase. Agents propose and
  flag.

## Surfaces

**MCP** (`/mcp`, streamable HTTP, bearer token): `knowledge_search`,
`memory_propose`, `memory_flag`, `graph_entity`, `graph_neighbors`,
`index_status`, `codebase_recap`. Serving a memory through search counts
as a use (audited).

**REST** (`/api`, bearer token):

| Route | Scope |
|---|---|
| `GET /search?q=&kinds=&entity=&limit=` | read |
| `GET /memories?status=&kind=&tags=&entity=&scope_kind=&scope_id=` · `GET /memories/:id` | read (review: all) |
| `POST /memories` | propose |
| `POST /memories/:id/flag` | propose |
| `GET /memories/review-queue` · `POST /memories/:id/{approve,reject,restore,archive}` · `PATCH /memories/:id` | review |
| `POST /memories/archive` `{filter, reason}`: bulk "context switch" | review |
| `POST /memories/erase` `{ids, reason}`: hard delete + cascade, returns the erasure report | review |
| `GET /audit?target_id=&since=` | review |
| `GET /graph/entities?type=` · `GET /graph/entities/:id?history=&as_of=` · `GET /graph/neighbors?id=&depth=&direction=&types=` | read |
| `GET /documents/collections` · `GET /index/repos` · `GET /index/runs` | read |
| `POST /index/repos/:owner/:name?force=&wait=` | index |
| `GET /recaps?repo=` · `GET /recaps/area?repo=&area=` | read |
| `GET /config` | review |

**Webhook**: `POST /webhooks/github`. Push to a tracked branch → queued
re-index (bursts collapse into one follow-up run; unchanged revisions skip).
