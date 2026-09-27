# Company knowledge: what the company knows, available to every agent

> Status: **first slice implemented** on `feat/company-knowledge`
> (`packages/knowledge`, `apps/hub`): memory governance, graph, search, a
> structural repo indexer, the hub (REST + MCP + push webhook). **Direction
> revised** (this doc): the knowledge base is built from company *sources*
> (Slack, GitHub, Linear, Notion, e-mail) and from LLM-written *codebase
> recaps*, not from code. Storage moves to Postgres + pgvector.
> Builds on
> [`research/company-agent-prior-art.md`](../research/company-agent-prior-art.md)
> and the Open-Inspect integration
> ([`integrations/open-inspect`](../../integrations/open-inspect/README.md)).

## What goes in

| Content | From | How it's kept fresh |
|---|---|---|
| **Codebase recaps** | An agent in an Atelier sandbox started from the repo's prebuild. One recap per repo, plus one per package/area for monorepos and complex codebases | On push, only the recaps of areas whose files changed are regenerated |
| **Conversations** | Slack channels and threads | Events API + backfill with a cursor |
| **Tickets and code discussion** | Linear issues and comments; GitHub issues, PRs, reviews, discussions | Webhooks + backfill |
| **Documents** | Notion pages and databases | Periodic sync (Notion has no reliable change webhooks) |
| **E-mail** (later) | Selected shared mailboxes | Gmail push / IMAP poll |
| **Memories** | Proposed by agents or people, approved by a human | Governed lifecycle (below) |

**No code is stored.** Agents that need code read it in a sandbox. The
structural indexer (workspaces, dependencies, CODEOWNERS) stays as a helper:
it tells the recap job which areas a push touched and gives the LLM a map of
the repo.

## Access: company-wide, no filtering

Everything in the knowledge base is readable by every agent and person that
can call the hub. There are no per-record permissions, audiences or identity
mapping.

- **Hub tokens** keep outsiders out, and **scopes** separate reading,
  proposing, reviewing and indexing.
- **What is ingested is the only control.** Each connector syncs an explicit
  allowlist (channels, Notion spaces, Linear teams, repos, mailboxes).
  Whatever is synced is visible to everyone. Default: public Slack channels
  only; no DMs, no private channels, no personal mailboxes unless listed.
- **Caveat:** an agent that answers *outsiders* (e.g. on a public repo's
  issues) must not get the hub's MCP, or it can quote internal knowledge.

## Data model

| Layer | What | Notes |
|---|---|---|
| **Sources** | A connector instance + its allowlist + sync cursor | `slack`, `github`, `linear`, `notion`, `email`, `recap` |
| **Items** | One record per thread, issue, PR, page, e-mail, recap | Source id + URL, author, timestamps, title, body, links. Upserted on edit, **erased** when deleted at the source |
| **Chunks + embeddings** | Search units | A Slack thread is chunked as a conversation, not per message |
| **Summaries** | LLM-derived: thread and ticket digests, decision logs | Linked to their items in `derivations`: erasing an item erases what was built from it |
| **Memories** | Durable facts, human-approved | Unchanged: propose → review → active → stale/archived → erase |
| **Graph** | Repos, packages, teams, people, tickets, channels and the links between them | "PR #12 fixes LIN-340, discussed in this thread". Temporal facts per source |

## Storage: Postgres + pgvector

Slack, Linear, GitHub and Notion history is hundreds of thousands to millions
of prose chunks, which is where vector search earns its keep, and where
sqlite's brute-force scan stops working. One Postgres keeps items, chunks,
vectors (HNSW), full-text search (`tsvector`), memories, graph and audit in
one transactional store, so an erase (item → chunks → vectors → summaries →
audit) stays atomic. A standalone vector DB would split that across two
systems. The first slice's sqlite store is ported; its tests carry over.

## Access by LLMs

The hub's MCP (`knowledge_search`, `memory_propose`, `memory_flag`,
`graph_entity`, `graph_neighbors`, `index_status`, plus `item_get` for full
threads/pages) is the only way in. Wiring it into agents:

1. **Launchpad / Atelier sandboxes**: the company toolbox adds the hub's MCP
   entry with a hub token, so every harness (pi-web, opencode, …) can search
   company knowledge while it works.
2. **Open-Inspect sessions**: same MCP entry, plus a post-session step that
   proposes memories from the thread.
3. **Later, a hub concierge** with a chat surface in Launchpad: answers from
   the knowledge base and launches workspaces through Atelier's API.

## Plan

1. Drop the permission layer (done) and **port to Postgres + pgvector**, with
   the sources → items → chunks model.
2. **Codebase recaps** (headless pi, above) + **GitHub connector**
   (issues, PRs, reviews).
3. **Slack** connector (public channels allowlist).
4. **Linear**, then **Notion**.
5. **Wire the MCP** into the Launchpad toolbox and Open-Inspect.
6. **E-mail** (shared mailboxes only).
7. Concierge + Launchpad chat.

## Hub configuration (decided)

| Setting | Default | Notes |
|---|---|---|
| `llm.baseUrl` | `http://atelier-cliproxy.atelier-system.svc.cluster.local:8317` | The cluster's cliproxy. Any Anthropic- or OpenAI-compatible endpoint works |
| `llm.api` | `anthropic-messages` | or `openai-completions` |
| `llm.model` | `claude-sonnet-5` | Used for recaps and summaries |
| `llm.thinking` | `medium` | |
| `HUB_LLM_API_KEY` (env) | — | cliproxy client key; never in the JSON config |
| `retention.slackMonths` | `6` | Slack messages older than this are not synced and are erased by a daily sweep (with what was derived from them) |

## Codebase recaps: a headless pi explores the repo

The LLM decides the granularity, not a fixed rule. A recap run starts a
headless [pi](https://pi.dev) with the hub's LLM settings:

1. **Plan** (first run, or when a push touches files no area covers): pi
   explores the checkout, fed the structural map (workspaces, dependencies,
   CODEOWNERS), and writes `areas.json`: a list of areas `{id, title, paths}`
   sized to be explainable in one recap. A small repo gets one area; a
   monorepo gets one per app/package, or per group of small packages.
2. **Recap**: one pi run per area writes `<area>.md` (purpose, architecture,
   key flows, entry points, conventions, gotchas, how it connects to other
   areas), plus one repo overview.
3. **On push**: the diff since the last recapped revision maps to the areas
   whose `paths` match; only those are regenerated, given their previous
   recap and the diff.

Recaps become documents (source `recap`) and `documented_by` facts in the
graph. pi runs with `read, grep, find, ls, write` only (no `bash`), a
throwaway config dir and an environment holding only the LLM key, in the
hub's shallow checkout. Moving the run into an Atelier sandbox built from the
repo's prebuild (for repos that need their toolchain to be understood) is a
later executor behind the same interface.

## Decisions (first slice, still valid)

| Decision | Why |
|---|---|
| **Three lifecycles** | *Memory* is revocable and human-governed. *Graph facts* are derived and temporal. *Items/documents* mirror their source. Mixing them is how "erase" ends up impossible |
| **Agents propose, humans activate** | Only a user's own preferences auto-activate |
| **Erase is a hard delete with a cascade** | A record, what it owns (chunks, vectors, the graph facts a memory asserted) and everything linked in `derivations`, in one transaction with a content-free audit entry |
| **Temporal facts, asserted per source** | Re-asserting a source invalidates what it no longer states instead of deleting it, so past states stay queryable |
| **Pluggable embeddings** | Any OpenAI-compatible endpoint; a deterministic hashing embedder for tests. Vectors keyed by record, model and content hash |
