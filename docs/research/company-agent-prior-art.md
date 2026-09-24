# Company agent — prior art, build-vs-adopt, and a proposed shape

> Research date: 2026-09-25. Question: should Atelier grow a top-level
> "company agent" — reachable from GitHub/Linear/Slack/email/Telegram, with a
> governed company memory, a code knowledge layer re-indexed on push, and the
> ability to spawn prebuilt sandboxes, work autonomously, and open PRs?
>
> Method: six parallel web-research lanes (platforms, knowledge/memory, code
> graph, channels/runtime libs, published prior art, agent architecture) plus a
> codebase fit pass. Load-bearing claims about Open-Inspect, Open SWE and Chat
> SDK were re-checked by cloning the repos (all had commits in the last 48h).
> Star counts and vendor benchmark numbers are directional only.
>
> **Status:** the first step shipped as **Open-Inspect on Atelier**
> ([`integrations/open-inspect`](../../integrations/open-inspect/README.md)):
> Open-Inspect keeps the channels, sessions and PR loop; Atelier is its
> sandbox provider (`personalize: false` spawns from the `open-inspect`
> seed). The hub, memory and code-knowledge layers below remain future work.

---

## TL;DR

1. **Nothing open source covers the whole brief.** The "tickets/Slack → sandbox
   → PR" loop is now well-trodden (two credible MIT projects), but **governed
   memory** (inspect / approve / invalidate / force-erase) and a **code
   knowledge layer rebuilt on push** are gaps in every project surveyed.
2. **Closest thing to plug on: Open-Inspect** (`ColeMurray/background-agents`,
   MIT, TypeScript). Same shape as Atelier — control plane outside, harness
   (OpenCode / Claude) *inside* the sandbox, pluggable sandbox providers,
   Slack/GitHub/Linear bots, automations, managed skills, GitHub-App token
   broker. An "Atelier provider" is a bounded piece of work. **Open SWE**
   (LangChain, MIT, Python) is richer but Python/LangGraph, agent loop outside
   the sandbox (not ACP harnesses), and explicitly "no external contributions,
   breaking changes expected".
3. **Recommendation: build it, as a separate deployable, in this monorepo
   for now** (`apps/hub` or similar), talking to Atelier **only through its
   public API** (`/v1`, `/sessions`, `/mcp`) so it can be extracted later.
   The v2 proposal already says "no agent orchestration in the runtime …
   possibly a separate app entirely" — this is that app. Borrow liberally from
   Open-Inspect's code; don't fork it.
4. **Libraries that remove most of the plumbing:** Vercel **Chat SDK**
   (channels, incl. GitHub, Linear agent sessions, Slack, Telegram, Gmail,
   Resend, Notion), **ACP harnesses** we already run, **Postgres + pgvector**
   (memory, knowledge, thread state, durable jobs), **SCIP indexers** (only if
   evals justify a structural index), optionally **Graphiti** (temporal
   facts) as a Python sidecar.
5. **Organisation:** a cheap, sandbox-less *concierge* that answers and
   triages, *workers* that each get one Atelier sandbox per thread, an async
   *memory curator*, and *indexer* jobs that run in Atelier sandboxes on push.
   Skills = procedures (git), memory = revocable facts (DB, reviewed), knowledge
   index = derived/rebuildable, tools/MCP = actions. A vector DB is needed only
   for the knowledge/memory search, and pgvector is enough.

---

## 1. Does an open-source project already exist that we could plug on?

| Project | License / stack | Covers | Missing vs brief | Verdict |
|---|---|---|---|---|
| **Open-Inspect** — [ColeMurray/background-agents](https://github.com/ColeMurray/background-agents) | MIT, TS (Cloudflare Workers *or* a Node container + SQLite), Python in-sandbox supervisor | Web/Slack/GitHub/Linear/webhook entry points, multiplayer sessions, PRs attributed to the prompting user, cron + event automations (GitHub, Sentry), parallel sub-tasks in separate sandboxes, managed skills, providers: Modal/Daytona/E2B/OpenComputer/Vercel (`SandboxProvider` with snapshot/restore capabilities) | No memory, no knowledge graph, no code index. **Single-tenant by design** (all users share the GitHub App installation's repo access) | **Best reference / spike target.** Its architecture is Atelier's; an Atelier provider maps onto prebuild snapshots + pause/resume |
| **Open SWE** — [langchain-ai/open-swe](https://github.com/langchain-ai/open-swe) | MIT, Python, LangGraph "Deep Agents" | Dashboard/GitHub/Slack/Linear/schedules, thread↔persistent sandbox, PR review, CI babysitting, learns repo review style, Notion OAuth, skill store, per-workspace GitHub credential scoping. Pluggable `SandboxProvider` (LangSmith default; Modal/Daytona/E2B/Runloop are ~20-line adapters over an execute+files protocol) | No governed memory, no code graph. Agent loop runs *outside* the sandbox and calls into it, so it doesn't use our ACP harnesses. README: "not accepting issues or external contributions … breaking changes" | Great to **read** (credential scoping, thread model, review loop); risky to build on |
| **OpenHands** (+ Software Agent SDK) | MIT core, Python | Resolvers for GitHub/GitLab/…; SDK "remote agent server" maps onto a sandbox | Slack/Linear/Jira, RBAC, org routing are **Cloud/Enterprise only**; OSS integration layer "tightly coupled to the enterprise server" ([#12967](https://github.com/OpenHands/OpenHands/issues/12967)) | Not a platform to adopt; SDK usable as one more harness |
| Cline SDK, Goose, Kilo, SWE-agent | Apache/MIT | Harnesses / local agents | Not company platforms | Candidate harnesses via ACP, nothing more |
| Coder (Tasks/Agents) | **AGPL-3.0**, Go | Control plane + workspaces + agents + audit | Competing orchestrator, AGPL | Architectural reference only |
| Onyx, Dust, Airweave | Onyx MIT core + proprietary `ee/`; Dust MIT (small OSS community); Airweave MIT | Company knowledge search with connectors (Onyx has real ACL sync) | Not coding agents | Possible *knowledge sidecar* (see §4) |
| OpenClaw | License unclear (NOASSERTION) | 20+ chat channels for a *personal* assistant | Not company/coding | Don't depend on it |
| Daytona, Sweep, Sourcegraph Amp | — | — | Daytona OSS frozen (June 2026), Sweep pivoted, Amp closed | Out |

**Commercial bar** (what "buy" looks like): Cursor cloud agents, OpenAI Codex,
Devin, GitHub Copilot coding agent, Google Jules — all now do
Slack + Linear + GitHub → PR. The case for building is: self-hosted on our own
Kata sandboxes and prebuilds, harness-agnostic, company knowledge + governed
memory, one agent for the whole company rather than per-developer. If those
aren't worth much to you, buying is cheaper.

### What published internal builds say (Stripe, Spotify, Ramp, Coinbase, Shopify)

- They all built the **harness, not the model**: sandbox, context wiring,
  permissions, orchestration, verification. Atelier is already that layer.
- **Insert the agent into an existing pipeline** (Spotify's Honk replaced
  only the "write the transform" step of Fleet Management; PR/review/merge
  untouched). Stripe Minions: ~1,000+ agent PRs/week, still human-reviewed.
- Internal agents took the **async/background** niche; engineers still use
  Claude Code / Codex / Cursor interactively.
- **Cost is the most repeated pain** (quotas, routing, caching needed from day
  one). Spotify openly lists latency/unpredictability, sandboxing and cost as
  unsolved.
- Spotify uses a two-step pattern: an interactive agent gathers context in
  Slack, then hands a distilled brief to the background coding agent.

Sources: [Stripe Minions](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents),
[Spotify Honk pt.1](https://engineering.atspotify.com/2025/11/spotifys-background-coding-agent-part-1),
[Modal on Ramp Inspect](https://modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal),
[The New Stack on Coinbase/Shopify/Ramp](https://thenewstack.io/enterprise-ai-agent-harness/) (secondary).

---

## 2. In Atelier, or a solo project?

**Separate deployable, same monorepo for now, API-only coupling.**

Why not *inside* `apps/server`: the v2 proposal's non-goals already rule it
out ("No agent orchestration in the runtime. ACP session facades, permission
brokering, multi-agent dispatch — legit products, all above the seam,
possibly a separate app entirely"). The hub brings webhooks, per-company
workflow logic, a Postgres store, LLM spend, and a different scaling profile.
The runtime/control/sessions boundary rules would erode.

Why not a *separate repo* yet: the first months will need matching changes on
the Atelier side (below). Atomic PRs across both sides, shared
`@atelier/spec` types, and the same Biome/tsc/CI make that much cheaper.
Enforce extractability the way `check:boundary` does today: the hub imports
only `@atelier/spec`, the browser-safe `@frak/atelier-shared`, and a generated
API client, never `apps/server/src/**`. Once the seams settle, moving it out is
mechanical. It also fits the roadmap's §7 "plugin system … could be externally
hosted since we have a proper API": the hub is the first real consumer of that
idea.

### Atelier-side changes worth doing regardless (they're runtime/control features)

| Gap (verified in code) | Where | Change |
|---|---|---|
| No machine identity; API keys are per-user (v2 open question #5) | `control/modules/api-key/` | Service accounts / org-scoped machine tokens with explicit scopes |
| Git credentials = the owner's GitHub OAuth token, GitHub-only (`TODO(generalize)` in `shared/lib/git-attribution.ts`) | control enrichment → `buildGitAttributionFiles` | Provider-agnostic credential list; accept a **short-lived GitHub App installation token scoped to the task's repos** from the caller; refresh on resume |
| ACP permissions assume a human (dashboard / chat auto-approve buffer) | `sessions/acp/agent-dispatch.ts` | A per-session **permission policy** (allow / deny / escalate) so headless sessions don't stall |
| No push → rebuild trigger (prebuild staleness is cron/`ls-remote`, private repos skipped without a token) | `runtime/git-remote.ts`, prebuild flow | Webhook- or API-triggered prebuild refresh. The same fresh snapshot then feeds indexing (§5) |
| No egress control story for agent sandboxes | K8s backend | Per-spec egress allowlist (NetworkPolicy), default-deny for autonomous runs |
| Session events are consumed by console/chat | `/sessions/*` | A stable server-to-server event stream (SSE/WS) per session, suitable for a hub |

---

## 3. Libraries that tackle big parts of the work

| Concern | Pick | Notes |
|---|---|---|
| **Channels** | **Vercel Chat SDK** (`chat` + `@chat-adapter/*`, MIT) | Official: Slack, Teams, GChat, Discord, **GitHub** (issue/PR comment threads), **Linear** (incl. agent sessions), **Telegram**, WhatsApp, **Gmail**, **Notion**, …; vendor-official **Resend**; state adapters incl. **Postgres**. Webhooks are `(Request) => Promise<Response>`, so they drop into Elysia. Young (adapters from ~Feb 2026): wrap it behind our own `Channel` seam |
| Slack specifics | `agent_view` + Agent Sessions API | `assistant_view` is deprecated (Feb 2027). Start on the new one ([changelog](https://docs.slack.dev/changelog/2026/08/20/agent-updates)) |
| Linear specifics | Linear agent (app actor, `actor=app`) | Must ack a session with a "thought" within **10 s**; work continues async ([best practices](https://linear.app/developers/agent-best-practices)) |
| GitHub | Own **GitHub App** | Installation tokens (restrictable to specific repos and permissions) for clone/push; the user's token only for on-behalf-of attribution if wanted. Note: GitHub's Copilot "assign to agent" API needs user tokens, which doesn't matter for our own app |
| Harness in sandbox | Existing ACP path (opencode, pi, claude-code-acp, …) | Keep; it's the differentiator vs Open SWE |
| Durable jobs | Postgres-backed (e.g. DBOS Transact TS or pg-boss) first; Temporal/Trigger.dev only if needed | My opinion: a thread→task state machine with a durable queue covers the "ack in 10 s, work for 30 min" shape. Temporal and Trigger.dev self-host are real clusters; `inngest-js` is GPLv3 |
| Credentials for SaaS tools | Native OAuth per integration first; **Nango** (ELv2, self-host) if the count grows | Composio's runtime is closed |
| Memory | Own tables on Postgres; optionally **Graphiti** (Apache-2.0, bi-temporal fact invalidation) as a sidecar | Mem0 (Apache-2.0) has CRUD+TTL, but graph-delete left orphans ([#3245](https://github.com/mem0ai/mem0/issues/3245)): verify erasure end-to-end with any library. No project ships an approval queue for learned facts |
| Vector / graph storage | **pgvector**; graph as plain tables | **Kuzu is dead** (archived Oct 2025, Apple acquisition). Neo4j/FalkorDB only if graph queries get heavy. MS GraphRAG is in maintenance mode |
| Code intelligence | Harness grep/LSP by default; **Serena** (LSP over MCP) as a live tool; **SCIP** indexers for a stored index; DeepWiki-style generated docs | See §5 |
| Company knowledge ingestion | Start federated (remote MCP servers: GitHub, Linear, Notion, Slack search); index selectively. Airweave (MIT) or Onyx if you want a turnkey sidecar | See §4 on ACLs |
| Observability | OpenTelemetry GenAI semconv spans from day one; backend TBD (Langfuse self-host is the usual pick) | Spec is still "Development" status |

---

## 4. Proposed organisation

```
 GitHub App ─┐   Linear agent ─┐   Slack agent_view ─┐   Gmail/Resend ─┐  Telegram ─┐
             └──────────────┬──┴────────────────────┴────────────────┴───────────┘
                            ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ HUB (apps/hub — Bun/Elysia, Postgres+pgvector)                                │
 │                                                                              │
 │  Gateway (Chat SDK adapters) → normalized Event {source, thread, actor,       │
 │  audience, text, links} → Thread store (external thread ⇄ hub thread ⇄ task)  │
 │                                                                              │
 │  Concierge agent (no sandbox, cheap model, read-only tools)                   │
 │    answers from: code wiki · knowledge search · memory · ticket/PR lookup     │
 │    decides: reply | ask clarifying question | create Task | escalate          │
 │                                                                              │
 │  Policy engine: allow | deny | require-approval  (per action × scope)         │
 │  Task runner (durable): brief → sandbox → stream progress → PR → follow-ups   │
 │  Memory service: propose → review queue → active → stale/archived → erase    │
 │  Indexers: on push / manual — code wiki, (SCIP), connector syncs              │
 │  MCP server for sandboxes: memory.search, memory.propose, knowledge.search,   │
 │    code.wiki, thread.reply, task.status   (scoped per task token)             │
 └──────────────┬───────────────────────────────────────────────────────────────┘
                │ Atelier public API only: /v1 sandboxes+prebuilds, /sessions (ACP), /mcp
                ▼
 ┌──────────────────────────────────────────────────────────────────────────────┐
 │ ATELIER — prebuild snapshot per repo(set) → Kata sandbox per thread           │
 │   ACP harness (opencode / pi / claude) + company skills toolbox               │
 │   + hub MCP + repo-scoped short-lived GitHub App token + egress allowlist     │
 │   thread follow-ups → resume the same sandbox (pause/resume already exists)   │
 └──────────────────────────────────────────────────────────────────────────────┘
```

**Roles**

- **Concierge** (in-hub, no sandbox): most Slack/Linear questions never need
  a sandbox. It reads the code wiki, memory and knowledge index, and only
  spawns work when a change or a run is needed. It also does Spotify's
  "gather context, then hand off a distilled brief" step.
- **Worker** (one Atelier sandbox per thread, not per message): the existing
  ACP harness does the coding. One sequential agent per task. Anthropic's own
  data says coding parallelises poorly across sub-agents; fan-out is for
  independent tasks.
- **Reviewer** (optional, fresh context): checks the diff against the brief
  before the PR is marked ready. Human review stays the merge gate.
- **Memory curator** (async, after a thread closes): extracts *candidate*
  memories with provenance and sends them to the review queue.
- **Indexers**: jobs that run *in Atelier sandboxes* from the fresh prebuild
  snapshot (§5).

**Skills vs tools vs memory vs knowledge.** Yes, skills are relevant:

| Kind | What | Lives in | Lifecycle |
|---|---|---|---|
| **Skills** (SKILL.md) | Stable procedures: "how we release", "how to triage a P1", commit/PR conventions, "how to answer a customer-bug report" | A `company-skills` git repo, shipped to sandboxes as an **Atelier toolbox** (content-addressed, cached) and loaded by the concierge too. pi, opencode and Claude Code all read skills | Changed by PR, code-reviewed |
| **Tools / MCP** | Actions with contracts: git/PR, Linear/Slack/GitHub writes, sandbox lifecycle, hub queries | Hub MCP + integration MCPs | Scoped per task, policy-gated |
| **Memory** | Facts that can become false or that someone may want erased: "team X owns service Y", "we dropped feature Z in 2026-08", user/channel preferences | Hub DB | Proposed → approved → active → stale/archived → erased |
| **Knowledge index** | Big derived corpora: code wiki, symbol index, Slack/Notion/Linear history | Hub DB (+ pgvector) | Rebuilt from sources; you don't "edit" it, you re-index or exclude sources |

Rule of thumb: procedural & stable → skill. Actionable with an API → tool.
Could be wrong later, or someone may ask to forget it → memory. Too big for
context → knowledge index. Memories that keep being useful as procedures get
**promoted into skills via PR**.

### Memory governance (the part nobody ships)

- Record: `{id, scope (org|team|repo|channel|user), kind, content, provenance[]
  (Slack permalink, PR, commit, thread id), created_by (agent|human),
  status (proposed|active|stale|archived), valid_from/valid_to, tags
  (product area, repo), last_used_at, use_count, embedding}`.
- **Write path:** agents can only *propose*. Policy decides which scopes
  auto-activate (e.g. user preferences) and which need approval (org facts).
  Review queue in the console: approve / edit / reject / merge-with-existing.
- **Read path:** hybrid search (FTS + pgvector), injected with ids so the agent
  can cite them and users can say "that's wrong" → the memory gets flagged.
- **Context switch:** bulk-archive by tag/scope/date ("everything tagged
  `billing-v1` before 2026-08-01"). Superseding keeps history (Graphiti-style
  `valid_to`) instead of silent overwrite.
- **Force-erase:** hard delete of the record *and* its embeddings, derived
  summaries/skills-candidates and cached transcripts that quoted it. This
  needs a `derived_from` link table from day one. It's the part libraries get
  wrong (Mem0 #3245).
- **Audit:** who/what created, approved, used and erased each memory.

### Knowledge & ACLs: the easy-to-miss design constraint

A company-wide index answering in a *public* Slack channel can leak a
*private* Notion page or DM. Rule: **an answer may only use sources that the
whole audience of the reply can read** (channel members, issue visibility,
email recipients). Two ways to get there:
1. **Federated / just-in-time** (start here): query sources live through their
   MCP/APIs with credentials matching the audience. ACL-correct by
   construction, and consistent with the "agentic search beats RAG for code"
   evidence (Claude Code, Cline).
2. **Indexed**: store source ACLs with each chunk and filter at query time
   (Onyx does real permission sync). Only index what's slow or unsearchable
   live (Slack history, decisions, closed tickets).

### Security baseline (the "lethal trifecta")

Issues, PR comments, Slack messages and email are **untrusted input**. The hub
has **private data**, and replies/PRs/email are **exfiltration channels**
([Willison](https://simonwillison.net/2025/jun/16/the-lethal-trifecta/)).
Mitigate architecturally, not by prompting:
- Per-task, repo-scoped, short-lived GitHub App tokens. Never push to default
  or protected branches. PRs only, human merge.
- Default-deny egress from autonomous sandboxes, with allowlisted registries.
- Read vs write credential tiers. Who can trigger what (org members only;
  external issue authors can't start write tasks without a maintainer's
  command or label).
- Policy engine with `require-approval` for outbound email, public posts
  quoting internal sources, and anything touching secrets/infra repos.
- Attribution: bot identity, with "requested by @user" in the PR and
  optionally on-behalf-of commits.

---

## 5. Code knowledge, re-indexed on push

Evidence summary: agentic grep/read beat embedding-RAG inside Claude Code and
Cline for *single-repo edits*; nobody has benchmarked a *structural* index
against grep for cross-repo / impact questions. GitHub archived
`stack-graphs` (Sep 2025). The local "code graph over MCP" tools
(code-graph-rag, CodeGraphContext, …) are young single-maintainer projects.
So, in layers, cheapest first:

1. **In-sandbox (default, free):** the harness's grep/LSP; add **Serena**
   (LSP-backed MCP) if a harness lacks LSP.
2. **Code wiki per repo @ commit (high value, cheap):** on push to a tracked
   branch, Atelier refreshes the prebuild, and an indexer agent runs *in a
   sandbox from that snapshot* and writes/updates a DeepWiki-style doc set:
   architecture, modules, entry points, conventions, cross-repo contracts
   (APIs, events, shared packages). Stored per commit, diffable, and
   **incremental**: only sections whose files changed get regenerated. The
   concierge answers most "how does X work / where is Y" questions from this
   without a sandbox. Humans can browse it in the console. Manual trigger via
   API/console. This builds on what Atelier already has: prebuild content keys
   include remote HEAD, so "push → fresh snapshot" is close already.
3. **Structural index (only if evals show the need):** SCIP indexers
   (`scip-typescript`, `scip-python`, rust-analyzer SCIP, …) in the same
   indexer sandbox → symbols/refs tables in Postgres, keyed by (repo, commit).
   Cross-repo links via an explicit package→repo map (SCIP does not
   auto-discover them). Serves "who calls this API across repos" and impact
   analysis. CocoIndex is worth a spike for the incremental pipeline.

Build an eval set of ~20–30 real questions and tasks (Anthropic's advice:
start small with an LLM judge) *before* layer 3, and measure layer 1+2 first.

---

## 6. Suggested phasing

| Phase | Scope | Exit criterion |
|---|---|---|
| **0 — Atelier prerequisites** | Service accounts; injectable scoped git credentials (GitHub App); headless ACP permission policy; server-to-server session stream; push/API-triggered prebuild refresh; egress allowlist | A script can do *issue → sandbox → PR* with a bot identity, no human in the loop |
| *(optional spike, ~1 week)* | Write an Atelier `SandboxProvider` for Open-Inspect and run it on real tickets | Learn what the loop needs before designing our own; throwaway |
| **1 — Hub MVP** | `apps/hub`: GitHub App + Slack + Linear via Chat SDK; thread ⇄ sandbox binding; task runner; PR + follow-ups in the same sandbox; skills toolbox; cost/quotas per team; OTel traces | 20-task eval passes at an agreed rate; Linear 10 s ack met |
| **2 — Code wiki** | Push-triggered indexer; concierge answers without sandboxes; console browser | Most Q&A threads resolved without spawning a sandbox |
| **3 — Memory + knowledge** | Memory service + review queue + erase; federated knowledge via MCP; selective Slack/Notion indexing with ACLs | Erase is verified end-to-end; no cross-audience leaks in red-team tests |
| **4 — Extras** | SCIP layer if eval-justified; email/Telegram; scheduled automations (Sentry, CI failures); reviewer agent | — |

## Open questions for the team

1. Single-tenant (one company per hub, Open-Inspect's model) or multi-org from
   day one? Single-tenant is much simpler and matches "internal agent".
2. Who approves org-level memories: a rotating owner per team, or whoever
   triggered the thread?
3. Which harness is the default worker? Model routing and cost caps per team?
4. Do we want Launchpad users (non-technical) to reach the hub too, e.g.
   "ask the codebase" from Launchpad? It's the same concierge.

## Sources (primary, verified)

- Open-Inspect: https://github.com/ColeMurray/background-agents (README
  security model, `packages/control-plane/src/sandbox/provider.ts`)
- Open SWE: https://github.com/langchain-ai/open-swe (README,
  `agent/sandboxes/providers/`)
- Chat SDK: https://github.com/vercel/chat (`packages/adapter-*`,
  `apps/docs/adapters.json`, `types.ts` `handleWebhook(Request)`)
- OpenHands OSS vs Enterprise: https://docs.openhands.dev/enterprise/enterprise-vs-oss
- Linear agents: https://linear.app/developers/agents ·
  https://linear.app/developers/agent-best-practices
- Slack agent messaging: https://docs.slack.dev/ai/migrating-to-agent-messaging
- MCP authorization (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- Anthropic: multi-agent research system; effective context engineering;
  code execution with MCP; Agent Skills docs
- Graphiti temporal model: https://github.com/getzep/graphiti · Zep CE
  discontinued: https://blog.getzep.com/announcing-a-new-direction-for-zeps-open-source-strategy/
- Kuzu archived: https://github.com/kuzudb/kuzu ·
  MS GraphRAG maintenance mode: https://github.com/microsoft/graphrag
- Cline on not indexing: https://cline.bot/blog/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing
- GitHub Copilot agent security principles:
  https://github.blog/ai-and-ml/github-copilot/how-githubs-agentic-security-principles-make-our-ai-agents-as-secure-as-possible/
