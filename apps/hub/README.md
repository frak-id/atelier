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

Container image: `docker build --target hub .` (mount `/app/data` and
`/app/config/hub.config.json`).

## Access model

Tokens carry an **actor**, **scopes** and an **audience**.

- `read`: search, graph, active memories. `propose`: propose / flag memories
  (what agents get). `review`: the governance queue, audit log, and
  every memory regardless of audience. `index`: trigger re-indexing.
- **Audience** = who will see the answer. A record is used only if *every*
  audience principal can read it (`teams` in the config expands group
  membership). A Slack gateway answering in `#general` asks as `["org"]` and
  never sees `team:platform`-only memories. A request may pass `audience=`
  only with principals listed in the token's `mayAddress`.
- Only humans approve, edit, restore, archive and erase. Agents propose and
  flag.

## Surfaces

**MCP** (`/mcp`, streamable HTTP, bearer token): `knowledge_search`,
`memory_propose`, `memory_flag`, `graph_entity`, `graph_neighbors`,
`index_status`. Serving a memory through search counts as a use (audited).

**REST** (`/api`, bearer token):

| Route | Scope |
|---|---|
| `GET /search?q=&kinds=&entity=&limit=&audience=` | read |
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

**Webhook**: `POST /webhooks/github`. Push to a tracked branch → queued
re-index (bursts collapse into one follow-up run; unchanged revisions skip).
