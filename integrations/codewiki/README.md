# codewiki-sync

Generates codebase documentation with [CodeWiki](https://github.com/FSoft-AI4Code/CodeWiki)
(MIT, CLI `codewiki`, pinned to a commit — **not** the unrelated `codewiki`
package on PyPI) and pushes it into Onyx as ingested documents, so Atelier's
company-knowledge chat/agent (`integrations/onyx/`) can answer "how does X
work in the codebase" questions with citations, alongside GitHub/Slack/Linear/
Notion.

## Why CodeWiki (and not the alternatives)

- **CodeWiki**: agentic generation over a dependency graph (tree-sitter parse
  → module clustering → per-module LLM writeup), with a genuine
  component-level incremental updater (`--update`, comparing the saved graph
  in `temp/` + `metadata.json`'s commit against HEAD) and no embeddings
  service of its own — it writes plain Markdown pages that we push through
  Onyx's existing ingestion API, so Onyx's own embedding/search pipeline is
  the only one in play.
- **DeepWiki-open**: rejected — RAG over embedded chunks, and it needs its
  own embeddings service. That's a second embedding pipeline next to Onyx's,
  doubling the CPU-embedding-throughput concern already called out in
  `integrations/onyx/README.md`.
- **OpenDeepWiki**: rejected — it duplicates the "hub" features (chat UI,
  search, citations) Onyx already provides; we only want the *doc
  generation* half, fed into the hub Atelier already runs.

## What it does

Once per configured repo, each run of the CronJob (`k8s/20-cronjob.yaml`,
every 30 min):

1. Cheap remote check (`git ls-remote`) — if the branch's HEAD sha matches
   the last-synced commit in `state/<owner>__<repo>.json`, skip entirely
   (`FORCE=1` overrides this).
2. Shallow-fetches the branch into `DATA_DIR/repos/<owner>/<repo>`.
3. Configures `codewiki` non-interactively (provider `openai-compatible`,
   pointed at the in-cluster cliproxy) and runs `codewiki generate` into
   `DATA_DIR/wiki/<owner>/<repo>` — `--update` if that directory already has
   a previous build (`metadata.json` present), a full build otherwise. If
   `--update` fails, retries once as a full build (a corrupted/incompatible
   saved graph shouldn't wedge the repo forever).
4. Reads every top-level `*.md` page CodeWiki wrote (not `temp/`, which is
   its dependency-graph cache, not a doc), turns each into an Onyx ingestion
   document (`src/pages.ts`): sections split on `## ` headings, a GitHub
   `tree/<commit>/<module-path>` link resolved from `module_tree.json`, and
   metadata `{ repo, module, commit, generator: "codewiki" }`.
5. Diffs each page's content hash against the last sync: only calls
   `POST /onyx-api/ingestion` for pages that are new or changed, and
   `DELETE /onyx-api/ingestion/<id>` for pages that existed in the last sync
   but weren't produced this time (a module was merged/removed).
6. Saves `state/<owner>__<repo>.json` (`{ lastCommit, pages: {id: hash} }`)
   atomically (write-then-rename) so a crash mid-sync can't corrupt it.

One repo failing (bad token, `codewiki` crash, Onyx 5xx after retries) is
logged and skipped — it never stops the other configured repos, and the
process exits non-zero if any repo failed.

## The max-tokens finding

A real run of CodeWiki against this repo (~640 files) with the CLI's default
`--max-tokens 32768` truncated the LLM's module-clustering output mid-response,
which made CodeWiki silently fall back to a useless "whole-repo" mode (one
giant module instead of a real hierarchy). `--max-tokens 64000`
(`CODEWIKI_MAX_TOKENS`, default here) fixed it. If you see a wiki dir with a
single enormous page and a flat `module_tree.json`, that's this failure mode
— raise `CODEWIKI_MAX_TOKENS` further before assuming something else broke.

## Cost / time expectations

- Pages are generated **sequentially** (~1.7 min/page in the reference run)
  — a full build of a monorepo this size takes **hours**, not minutes.
  `activeDeadlineSeconds: 28800` (8h) in the CronJob reflects this.
- `--update` is genuinely incremental (component-level, not file-level) and
  cheap once a full build exists — most 30-minute ticks after the first will
  see no changed files and skip via the remote-HEAD check before even
  touching `codewiki`.
- The very first sync of a new repo is the expensive one. Consider running
  it once by hand (`bun run src/index.ts --repo owner/name`, same image,
  outside the CronJob's 30-min cadence) to seed `DATA_DIR` before letting the
  CronJob take over.

## Setup

1. **Terraform outputs** (`integrations/onyx/terraform/`):
   ```sh
   cd integrations/onyx/terraform
   terraform output wiki_sync_api_key   # -> ONYX_API_KEY (sensitive)
   terraform output wiki_cc_pair_id     # -> ONYX_CC_PAIR_ID (not sensitive)
   ```
2. **Secret** — see `k8s/10-secret.yaml.example` for the exact keys
   (`GITHUB_TOKEN` optional, `LLM_API_KEY`, `ONYX_API_KEY`). Never commit
   real values.
3. **Build & push the image** (in-cluster BuildKit + Zot, same pattern as
   `infra/k8s/v2/README.md` "Rebuild images"):
   ```sh
   docker build -f integrations/codewiki/Dockerfile \
     -t zot.zot.svc:5000/atelier-codewiki-sync:<tag> .
   docker push zot.zot.svc:5000/atelier-codewiki-sync:<tag>
   ```
4. **Apply the manifests** (namespace `onyx`, next to the Onyx release):
   ```sh
   kubectl apply -f integrations/codewiki/k8s/00-pvc.yaml
   # create the Secret from step 2, then:
   kubectl apply -f integrations/codewiki/k8s/20-cronjob.yaml
   ```
   Fill in the CronJob's `CODEWIKI_REPOS` and `ONYX_CC_PAIR_ID` placeholders
   first, or overlay them with kustomize/your GitOps tool of choice.

## Running locally

```sh
cd integrations/codewiki
DRY_RUN=1 DATA_DIR=/tmp/codewiki-data CODEWIKI_REPOS=owner/name \
  bun run src/index.ts --path . --repo owner/name
```

`--path <dir>` uses an existing local checkout instead of cloning (skips the
remote-HEAD check and the shallow fetch); `DRY_RUN=1` runs everything
(including `codewiki generate`, unless `SKIP_GENERATE=1`) but only prints
what would be pushed/deleted to Onyx instead of calling the API, and never
requires `ONYX_URL`/`ONYX_API_KEY`/`ONYX_CC_PAIR_ID`/`LLM_API_KEY`.
`SKIP_GENERATE=1` additionally skips invoking the `codewiki` CLI and reads
whatever's already in `DATA_DIR/wiki/<owner>/<repo>` — useful for trying the
Onyx-side plumbing against an existing CodeWiki output without waiting hours
for a real generation.

## Known limits

- **Language coverage**: CodeWiki's tree-sitter analyzers cover Python, Java,
  JavaScript/TypeScript, C/C++/C#, Kotlin, PHP, Ruby and Scala — there's no
  Rust or Go analyzer. In this monorepo that means `apps/agent-v2` (Rust)
  gets thin, mostly artifact-level coverage (Cargo.toml/Dockerfile, not the
  actual Rust source) rather than a real module breakdown.
- **Sequential generation**: see "Cost / time expectations" above — this is
  a CodeWiki architecture property (module docs build on each other), not
  something this job's concurrency could fix.
- **No RBAC on the ingested docs**: like the rest of `integrations/onyx/`
  (Community Edition), the wiki-sync `cc_pair`/document set is `public` —
  every logged-in Onyx user can see every synced page, matching Onyx CE's
  uniform-access model.
- **`ONYX_CC_PAIR_ID` isn't a secret** but does need to match a real
  ingestion-only cc_pair (`integrations/onyx/terraform/wiki.tf`) — pointing
  it at an arbitrary id will 404/permission-error on every upsert.

## Files

- `src/config.ts` — env parsing/validation.
- `src/git.ts` — shallow fetch + cheap remote-HEAD check.
- `src/codewiki.ts` — configures and runs the `codewiki` CLI.
- `src/pages.ts` — wiki dir → Onyx documents (+ content hashing).
- `src/onyx.ts` — minimal ingestion API client (upsert/delete/list, retries).
- `src/sync.ts` — per-repo orchestration + state diffing; `syncAll` never
  lets one repo's failure stop the rest.
- `src/index.ts` — CLI entrypoint (`--repo`, `--path`, `FORCE`,
  `SKIP_GENERATE` env vars).
- `Dockerfile` — `python:3.12-slim` + CodeWiki (pinned commit, installed from
  git — the PyPI `codewiki` package is unrelated) + the Bun binary + the
  sync job bundled to a single file (`bun build --target bun`).
- `k8s/` — PVC, Secret template, CronJob (namespace `onyx`, every 30 min).
