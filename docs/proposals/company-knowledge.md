# Company knowledge: governed memory, knowledge graph, code index

> Status: **first slice implemented** on `feat/company-knowledge`
> (`packages/knowledge`, `apps/hub`). Builds on
> [`research/company-agent-prior-art.md`](../research/company-agent-prior-art.md)
> (phases 2–3) and the Open-Inspect integration
> ([`integrations/open-inspect`](../../integrations/open-inspect/README.md)).

## Why this slice first

The research found the "ticket/Slack → sandbox → PR" loop well covered.
Open-Inspect on Atelier already runs it. What nobody ships is:

1. **Governed memory**: facts agents learn, reviewed by humans, correctable,
   bulk-retirable on a context switch, and **erasable end-to-end**.
2. **A code knowledge layer re-indexed on push**, answering "who owns /
   who imports / how does X work" without spawning a sandbox.
3. **Audience-correct retrieval**: an answer in a public channel must not
   use a private source.

These are also the parts every later piece (concierge, workers, Open-Inspect
sessions, a developer's own harness) consumes, through one MCP endpoint. So
they come before the channels, which Open-Inspect covers for now.

## Shape

```
packages/knowledge  (@atelier/knowledge: pure domain, Bun + bun:sqlite, no server)
  types.ts            the contract
  db.ts               schema (FTS5 external-content tables + triggers), user_version migrations
  memory/             MemoryService (lifecycle, policy), audit.ts, derivations.ts, erasure.ts
  graph/ documents/   SqliteGraphStore (temporal facts), SqliteDocumentStore
  search/             KnowledgeSearch (FTS5 + vectors, RRF), embedders
  indexer/            indexRepository: checkout → RepositoryIndex (pure)
  apply.ts            RepositoryIndex → stores

apps/hub            (@atelier/hub: Elysia deployable)
  /api  REST          search, memories + review queue + erase, graph, index runs
  /mcp  MCP           knowledge_search, memory_propose, memory_flag, graph_entity,
                      graph_neighbors, index_status
  /webhooks/github    push → IndexRunner (fetch → index → apply → embed)
```

The hub imports only `@atelier/knowledge`. It does not import `apps/server`,
same extraction rule as the research doc's §2.

## Decisions

| Decision | Why |
|---|---|
| **sqlite (bun:sqlite + FTS5), not Postgres + pgvector yet** | Same operational footprint as the Atelier server (one file, one PVC), zero services to run, fully testable in-memory. Brute-force cosine is fine to ~100k vectors. The stores sit behind `GraphStore` / `DocumentStore` interfaces; Postgres is a swap when scale or multi-writer needs it |
| **Raw SQL, not drizzle** | FTS5 external-content tables and triggers aren't modelled by drizzle; the schema is small |
| **Three record kinds, three lifecycles** | *Memory* is revocable and human-governed. *Graph facts* are derived and temporal. *Documents* are rebuilt from sources. Mixing them is how "erase" ends up impossible |
| **Agents propose, humans activate** | Default policy auto-activates only user-scoped preferences. Everything else lands in the review queue |
| **Erase is a hard delete with a cascade** | A `derivations` table (parent → child) is written from day one. Erasing a memory deletes it, its embeddings, FTS rows, the graph facts it asserted, and every derived record; `external` derivations (a cached transcript, a skill PR) are reported to `ErasureHook`s. The audit trail records *that* it was erased and by whom, never the content |
| **Temporal facts, asserted per source** | A source (`indexer:<repo>`, `memory:<id>`) re-asserts its whole set. Facts it no longer states are invalidated (`validTo`), not deleted, so "what did X depend on last month" works (`asOf`) |
| **Memories can carry facts** | "team:payments owns service:billing" as a structured claim, asserted under `memory:<id>` while active, retracted when flagged/archived, deleted on erase. This is how human knowledge enters the graph |
| **Audience rule enforced in the store layer** | A record is used only if every audience principal is covered by one of its readers (group membership via an `AccessResolver`). Search over-fetches and filters so ACL-filtered hits don't starve results |
| **Deterministic indexer first, LLM wiki later** | Workspaces, manifests, internal deps, cross-package imports, CODEOWNERS, markdown docs chunked by heading. Cheap, exact, re-runs on every push. The indexer output (`RepositoryIndex`) is plain JSON, so it can be produced anywhere, including an Atelier sandbox |
| **Pluggable embeddings** | `HashingEmbedder` (deterministic, offline, dev/tests) or any OpenAI-compatible `/embeddings` endpoint. Vectors are keyed by `(record, model)` + content hash, so model switches and edits re-embed lazily |

## Next steps (ordered)

1. **Console: review queue + audit** (`apps/console`): approve / edit /
   reject / merge, bulk archive by tag and date, erase with the report shown.
   The REST API is ready for it.
2. **Wire agents to the hub**:
   - Atelier: a `hub` MCP entry in the company skills toolbox, so every
     sandbox harness gets `knowledge_search` / `memory_propose` with a
     per-sandbox agent token.
   - Open-Inspect: extend `integrations/open-inspect` so sessions receive the
     hub MCP server, and a post-session hook proposes memories from the
     thread (the "memory curator" role).
3. **Index in a sandbox from the prebuild** (research §5, layer 2):
   `IndexRunner.checkout/extract` become "spawn an Atelier sandbox from the
   repo's prebuild, run `indexRepository`, return the JSON". Same stores.
   Then add the **LLM code wiki** as another document collection
   (`wiki:<repo>`), regenerated per changed package only.
4. **Atelier prerequisites** from the research's phase 0 that the hub now
   needs: service-account API keys (the hub's Atelier identity), push →
   prebuild refresh (the same webhook can fan out), headless ACP permission
   policy.
5. **Concierge**: a cheap, sandbox-less agent in the hub that answers from
   `knowledge_search` + graph, and hands a brief to a worker (Open-Inspect
   session or Atelier sandbox) when a change is needed. Channels via Chat SDK
   once Open-Inspect's bots are not enough.
6. **Evals** before anything structural (SCIP): 20–30 real questions against
   the current graph + docs + memory.

## Open questions

- Who reviews org-scoped memories: per-team owners from CODEOWNERS (the
  graph already knows them) or a single knowledge owner?
- Should `ownership` facts from CODEOWNERS and from approved memories be
  reconciled (conflict surfaced in the review queue)?
- Identity: hub principals (`user:alice`) vs Atelier user ids vs Slack/GitHub
  ids. A small identity map is needed before real ACLs from channels.
