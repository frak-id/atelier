# Company knowledge: Onyx + CodeWiki, wired into Atelier

> Status: **implemented as integrations** on `feat/onyx-knowledge`:
> [`integrations/onyx`](../../integrations/onyx/README.md) (Helm values,
> deploy script, Terraform), [`integrations/codewiki`](../../integrations/codewiki/README.md)
> (codebase wiki → Onyx sync job) and Launchpad tools on Atelier's `/mcp`.
> Not yet deployed to the cluster. Evaluation:
> [`research/company-knowledge-tools.md`](../research/company-knowledge-tools.md).
> Context: [`research/company-agent-prior-art.md`](../research/company-agent-prior-art.md).

## Goal

Everything the company knows, available to every person and agent:

- **Codebases**: what each part does, how it fits together, kept current on
  every push. Not the code itself (agents read code in sandboxes).
- **Conversations and work history**: Slack (public channels, last 6 months),
  GitHub issues/PRs/reviews, Linear, Notion, later e-mail.
- **Access**: a chat that answers with sources and can start work on the
  Launchpad; the same knowledge as MCP tools for coding agents in Atelier
  sandboxes and Open-Inspect sessions.

Knowledge is company-wide: no per-record permissions and no identity mapping.
What gets indexed is the only control (each connector has an allowlist).

## Decision: adopt, don't build

A first slice was built in-house (governed memory, temporal graph, sqlite
hybrid search, a hub with REST/MCP, headless-pi codebase recaps; archived on
branch `feat/company-knowledge`). Once per-record permissions and erasure were
dropped as requirements, what remained is what Onyx already does, with more
connectors, a chat UI, agents and a Slack bot; and CodeWiki produces deeper
codebase documentation than the recap job. Both are MIT and self-hosted.

## Architecture

```
 Slack · GitHub · Linear · Notion · (Gmail)          private GitHub repos
            │ Onyx connectors                              │ CronJob (30 min)
            ▼                                              ▼
 ┌──────────────────────────────────────┐    ┌──────────────────────────┐
 │ Onyx (namespace onyx)                │◄───│ codewiki-sync            │
 │  OpenSearch hybrid index, embeddings │ ingestion API   CodeWiki     │
 │  (own model servers), Postgres, …    │    │  generate / --update     │
 │                                      │    └──────────────────────────┘
 │  chat UI · agent "Atelier" ──────────┼── MCP action (user's own atl_ key) ─▶ Atelier /mcp
 │                                      │                                     launchpad_* tools
 │  MCP server (search, open_urls) ◄────┼── opencode / Claude Code / pi in sandboxes, Open-Inspect
 └──────────────────────────────────────┘
            │ chat completions only
            ▼
   cliproxy (in-cluster) · claude-sonnet-5 by default
```

| Piece | Where | Notes |
|---|---|---|
| Onyx deployment | `integrations/onyx/helm/values.yaml`, `deploy.sh` | Official chart pinned with its image tag; Traefik ingress + cert-manager; trimmed for a small company |
| Onyx configuration | `integrations/onyx/terraform/` | Official Terraform provider: LLM (cliproxy, model configurable), connectors, Slack window, wiki ingestion target + document set, Atelier MCP action, the "Atelier" agent, API keys |
| Codebase wiki | `integrations/codewiki/` | CodeWiki (dependency graph + agents, component-level incremental updates) run by a CronJob; pages pushed through Onyx's ingestion API, stale pages deleted |
| Launchpad from chat | `apps/server/src/api/mcp/tools/launchpad.ts` | `launchpad_catalog`, `launchpad_launch`, `launchpad_workspaces`, `launchpad_workspace`, `launchpad_workspace_action`, acting as the calling user |

## Decisions

| Decision | Why |
|---|---|
| **LLM through cliproxy**, `claude-sonnet-5` default, configurable (Terraform variables for Onyx, env for CodeWiki) | One place for keys and quotas. cliproxy has no embeddings; Onyx embeds with its own model servers and CodeWiki needs none |
| **Slack: public channels, last 6 months** (`slack_history_months`) | Public-only is enforced by the Slack app's scopes. Onyx has no rolling retention, so a `time_rotating` resource replaces the Slack connector monthly: its documents are deleted and the last N months re-indexed. Needs a monthly `terraform apply` (scheduled CI) |
| **Per-user Atelier action** (`auth_performer = PER_USER`) | Workspaces launched from the chat belong to the person asking, as on the Launchpad |
| **No delete over MCP** | Destructive; stays in the console |
| **GitHub connector without files** | Code knowledge comes from the wiki; raw files would drown the index |
| **CodeWiki `--max-tokens 64000`** | The default truncated module clustering on this monorepo |

## Known limitations

- **Footprint**: Onyx is several services (OpenSearch, two model servers,
  Celery workers, Postgres, Redis, MinIO), roughly 4–8 CPU and 12–16 GiB
  requested even trimmed.
- **CodeWiki**: first builds take hours (pages generated one at a time); no
  Rust/Go analyzers, so `apps/agent-v2` gets thin coverage.
- **Terraform provider 0.3.x** is young; the agent's MCP tools are discovered
  by Onyx after the server is registered, so the very first apply may need a
  second one.
- **CE has no RBAC**: API keys can't be scoped down. Acceptable with
  company-wide knowledge; keep the keys in cluster secrets.
- **An agent that answers outsiders** (e.g. on a public repo) must not get
  the Onyx MCP.

## Next steps

1. Deploy: `integrations/onyx/deploy.sh`, first admin, `terraform apply`,
   connector secrets (Slack app, GitHub PAT, Linear key, Notion integration).
2. Build/push the `codewiki-sync` image, apply `integrations/codewiki/k8s/`.
3. Monthly `terraform apply` in CI (Slack window).
4. Put the Onyx MCP entry in the org toolbox so every sandbox's harness gets
   it; pass it to Open-Inspect sessions.
5. Evaluate on real questions for a week; then decide on Gmail and on
   CodeWiki coverage for Rust.
