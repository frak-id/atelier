# Company knowledge: build vs. adopt (Onyx, codebase-wiki generators)

> Researched 2026-09-28 from the projects' source (GitHub `main`), official
> docs and hands-on runs. Decision record:
> [`proposals/company-knowledge.md`](../proposals/company-knowledge.md).
> Supersedes the in-house hub prototype (branch `feat/company-knowledge`:
> `packages/knowledge` + `apps/hub`, sqlite + FTS5 + a headless-pi recap job).

## Why adopt instead of build

The prototype's reasons to build were per-record read permissions and
end-to-end erasure. Both were dropped as requirements (company knowledge is
readable by everyone in the company; deletion is not required). Without them,
the remaining work (connectors, sync, hybrid search, chat, a Slack bot, MCP)
is exactly what existing open-source platforms ship.

## Knowledge platform

| Project | What it is | Verdict |
|---|---|---|
| **[Onyx](https://github.com/onyx-dot-app/onyx)** (formerly Danswer; MIT CE + source-available `ee/`) | Self-hosted knowledge platform: 50+ indexing connectors (GitHub, Slack, Linear, Notion, Gmail…), hybrid search (OpenSearch), self-hosted embeddings, chat UI, agents with actions (incl. external MCP servers), a Slack bot, its own MCP server, an ingestion API | **Adopted** |
| [Airweave](https://github.com/airweave-ai/airweave) (MIT) | Connectors + one search API/MCP for agents | No chat, no agents; Onyx covers it |
| [SurfSense](https://github.com/MODSetter/SurfSense) | "NotebookLM for teams", now web-research oriented; most work-tool connectors are live tools, not indexed | Weaker fit |
| Glean, Dust, Unblocked | Commercial equivalents | Not self-hosted/open |
| [PageIndex](https://github.com/VectifyAI/PageIndex), [OpenKB](https://github.com/VectifyAI/OpenKB) | Reasoning-based navigation of long documents; LLM-compiled markdown wiki (single-user CLI) | Wrong shape for millions of short items; ideas only |

Onyx facts that shaped the integration (all from `onyx-dot-app/onyx` `main`):

- **Helm chart** `deployment/helm/charts/onyx` (0.8.38): OpenSearch is the only
  bundled index since chart 0.5.0 (Vespa removed), plus CloudNativePG, Redis,
  MinIO. Chart defaults request roughly 6–8 CPU / 16–20 GiB; image tag and
  chart version must move together (distroless model-server from chart 0.7).
- **LLM** providers are LiteLLM-based and API-managed (`PUT
  /admin/llm/provider`), so the cluster cliproxy works as an OpenAI-compatible
  provider (`/v1/chat/completions` verified with `claude-sonnet-5`).
  Embeddings run in Onyx's own model servers (`nomic-embed-text-v1.5`, CPU;
  see [#8396](https://github.com/onyx-dot-app/onyx/issues/8396) for CPU
  throughput under load).
- **CE** includes email/password auth, one SSO provider, service-account API
  keys and PATs. RBAC, group-scoped access and permission sync are EE, which
  we don't need.
- **Config as code**: the official
  [Terraform provider](https://github.com/onyx-dot-app/terraform-provider-onyx)
  (0.3.x) covers LLM providers, credentials, connectors, cc-pairs, document
  sets, agents, MCP servers, custom tools and API keys.
- **Slack retention**: a connector's `indexing_start` is a fixed date, and
  pruning lists the whole history
  (`backend/onyx/background/celery/celery_utils.py` calls
  `retrieve_all_slim_docs_perm_sync()` without `start`), so there is no rolling
  window. Destroying a cc-pair deletes its documents, so the window is
  implemented as a monthly replacement of the Slack connector.
- **Ingestion API** (`backend/onyx/server/onyx_api/ingestion.py`): upsert by
  document id into a cc-pair; delete works only for ingested documents.
- **MCP**: Onyx serves one (`search_indexed_documents`, `search_web`,
  `open_urls`) and consumes external ones as agent actions, with a shared
  token or a per-user token (`auth_performer = PER_USER`).

## Codebase wiki generator

Baseline: the prototype's headless-pi recap job (agent explores the checkout,
~10k LOC per area, 15 area recaps + overview of this monorepo in ~5 min,
regenerates areas whose files changed).

| Tool | Method | Embeddings | Incremental | Verdict |
|---|---|---|---|---|
| **[CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki)** (MIT, v2.0, ACL 2026 paper) | Tree-sitter dependency graph → LLM clustering into a module hierarchy → one agent per leaf module reading code through tools; parent pages synthesized; Mermaid diagrams validated | None | Component-level (`generate --update`: diffs the saved graph, rewrites only affected leaf pages in dependency order) | **Adopted** |
| [deepwiki-open](https://github.com/AsyncFuncAI/deepwiki-open) (MIT) | RAG over 350-word chunks (FAISS, top-20) | Required (OpenAI by default; Ollama as the only self-hosted option) | Regenerate | Rejected: weaker method + an extra embeddings service |
| [OpenDeepWiki](https://github.com/AIDotNet/OpenDeepWiki) (MIT, .NET) | Agentic (Semantic Kernel tools over git/grep/read) | None | Repo-level polling | Rejected: a full multi-user hub product duplicating Onyx |
| Cognition DeepWiki | Hosted | — | — | Public repos only |

CodeWiki run on this monorepo (Sonnet 5 through cliproxy):

- With the default `--max-tokens 32768` the clustering answer was truncated
  and CodeWiki fell back to a whole-repository prompt that does not fit the
  context window. `--max-tokens 64000` fixed it.
- It found 27 top-level modules, split into sub-modules (e.g. four CI/CD pages:
  CI, release pipeline, versioning, image maintenance), 12–15 KB each,
  cross-linked, with job/flow diagrams, and accurate in the pages
  spot-checked, noticeably deeper than the prototype's area recaps.
- Pages are written one at a time (~1.7 min each), so a first build of a
  monorepo takes hours; later runs use `--update`.
- No Rust or Go analyzer: `apps/agent-v2` gets thin coverage.
- The PyPI package named `codewiki` is an unrelated project: install from git.
