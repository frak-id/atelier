# Agent review

A GitHub Action that has coding agents review each pull request in an Atelier
sandbox, on every push, and posts their findings as one review.

The job starts a sandbox from the repository's prebuild, at the PR's head, as
an Atelier [service account](../../docs/service-accounts.md). Two tasks of the
sandbox's coding agent (pi) review what the PR brings, from its merge base to
its head, at the same time, each with its own parallel sub-agents. Both read
the repository's AGENTS.md rules. One looks for issues: correctness,
security, data, deploy impact and tests. The other looks for improvements:
performance, duplicated code, and the repository's conventions. Each writes
its findings to a file. The job checks both and posts them as one review from
`github-actions[bot]`, then destroys the sandbox.

## Usage

```yaml
name: Agent review

on:
  pull_request:
    types: [opened, reopened, ready_for_review, synchronize, closed]

permissions:
  contents: read

# A newer push cancels the review in progress, and closing the PR cancels it
# too.
concurrency:
  group: agent-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    # Drafts wait for ready_for_review. A closed PR's run only cleans up.
    if: github.event.action == 'closed' || !github.event.pull_request.draft
    runs-on: ubuntu-latest
    # The sandbox's boot (10 minutes at most), the agents (40), the posting.
    timeout-minutes: 60
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: frak-id/atelier/actions/agent-review@main
        with:
          atelier-url: https://atelier.example.com
          api-key: ${{ secrets.ATELIER_REVIEWER_API_KEY }}
      # Cancelled mid-review (a newer push, the timeout): the step above could
      # not destroy its sandbox. This one does.
      - if: cancelled()
        uses: frak-id/atelier/actions/agent-review@main
        with:
          atelier-url: https://atelier.example.com
          api-key: ${{ secrets.ATELIER_REVIEWER_API_KEY }}
          mode: cleanup-head
```

Pin a release tag or a commit SHA instead of `@main` to choose when the action
changes.

The action runs on `pull_request` events only. A pull request from a fork is
skipped with a notice: it gets no secret, Atelier can't boot its branch, and
its code would run with the secrets of the account's org. So is a Dependabot
run, which gets no secret either. Any other run without the API key fails and
says why.

### Inputs

| Input | Default | What it is |
|-------|---------|------------|
| `atelier-url` | required | Base URL of the Atelier server |
| `api-key` | required | The service account's API key (`mcp` scope), from a secret |
| `mode` | `review`, or `cleanup` on a `closed` event | `cleanup` destroys the PR's review sandboxes and deletes the progress comment. `cleanup-head` goes in the `if: cancelled()` step |
| `image` | `dev-base` | Base image the sandbox boots on. Atelier reuses the repository's prebuild on it |
| `subagents` | `auto` | `auto`: each agent alone on a diff of at most 500 changed lines (lockfiles aside), sub-agents on a bigger one. `always` or `never` to choose |
| `allowed-findings` | | How many minor issues and improvements per category a review reports, for a diff of up to 600 changed lines (*What it reports*) |
| `reviewer-model` | | The sub-agents' model, `provider/model` as pi-subagents names it (*Customise*) |
| `toolboxes` | | Toolboxes on top of the org's auto-included ones, comma- or line-separated selectors (*Customise*) |
| `instructions` | | Text added to the agents' prompts (*Customise*) |
| `instructions-file` | `REVIEW.md` | Instructions read on the PR's target branch, when the file is there. Empty to read none |
| `agent-timeout-minutes` | `40` | The agents' time for one review. Give the job about 20 minutes more |
| `vcpus`, `memory-mb` | | The sandbox's size, where both agents and their sub-agents run at once. Empty: Atelier's defaults |
| `bun-version` | `1.4.4` | Bun version the action runs on |

The review is posted with the job's own `GITHUB_TOKEN`, hence
`pull-requests: write`. Later runs find the earlier reviews and the progress
comment by that account, `github-actions[bot]`.

## Setup on Atelier

1. **An org for the reviewer.** A service account gets every secret of its
   org, and its sandboxes run the PR's code: the prebuild's build steps run
   again on the PR's branch. Give it an org that holds only what the review
   needs, such as the model key.
2. **Its coding agent.** On a big diff the prompts have pi delegate to its
   `reviewer` sub-agent (pi-subagents' built-in one), so the org's sandboxes
   need pi with [pi-subagents](https://github.com/nicobailon/pi-subagents),
   unless `subagents` is `never`. The two agents are two ACP sessions of the
   same pi install. The console's Library suggests a pi toolbox
   that has it. Make it auto-included in the org.
3. **A service account** in that org, with a read-only GitHub credential.
   For a GitHub App, narrow its token with
   `"permissions": { "contents": "read", "pull_requests": "read", "metadata": "read" }`:
   the default is write. The agent can then fetch but not push or comment, and
   only the job posts.
4. **An API key** for the account, with the `mcp` scope (the default for a
   service account). Store it as an Actions secret of the repository. On
   GitHub's free plan, an organization secret reaches a private repository's
   workflows as an empty string.
5. **A prebuild of the repository** on the `image`. Without one, the first
   review bakes it, which can take longer than the 10 minutes a sandbox has to
   boot. A PR's sandbox boots from it, switched to the PR's branch.

People in the account's org can watch the agent work: the progress comment
links to the sandbox's session in the console (sign in with GitHub).

## How a review goes

The sub-agents read files but can't run git, so the job first writes the diff
into the sandbox, one patch per file (`src/diff-files.sh`). Then it starts two
tasks there, at the same time, each an agent with its own context, sub-agents
and file:

- **Issues** (`src/prompt.ts`): bugs, security, data and migrations, deploy
  impact, tests, and the repository's rules. Its findings are rated critical,
  major or minor.
- **Improvements** (`src/improvements.ts`): what would make the code faster
  (`performance`), less duplicated, against what the whole repository already
  has (`duplication`), or closer to the way the repository does things
  (`conventions`), without being a bug. Its findings have a category instead
  of a severity, and never block. A performance problem that breaks something,
  or a rule broken with real consequences, is the other agent's.

Apart, neither weighs a bug against a nicer loop, and a failure of the
improvements' agent leaves the issues' review whole: it's posted, saying the
improvements weren't reviewed. Both share the sandbox, its boot and the diff
files, and the agents' time.

With `subagents: auto`, a diff of at most 500 changed lines, lockfiles aside,
is reviewed by each agent alone: sub-agents start cold, and cost more than
they find there. On a bigger diff, each sizes its review to it. The issues'
agent runs about one sub-agent per 2,000 changed lines, at least two and at
most 12, and every patch read by one. The improvements' agent runs at least
one per category, split by area past 5,000 lines, at most 9.

The review says whether it blocks: 🛑 *Blocking* with any critical or major
finding, ✅ *Not blocking* with only minor ones, or LGTM, with the counts per
severity. Each critical or major finding is a comment on its line of the diff.
A finding on a line the diff doesn't show is listed in the review's body. Minor
findings are listed collapsed at its end, never as comments: they're the
author's to take or leave. Under each finding, collapsed, is its evidence: how
the agent confirmed it, for whoever doubts it.

- **What it reports.** The first review reports the critical and major
  findings, and a few minor ones and improvements, the most worth making.
  `allowed-findings` sets how many of each kind for a diff of up to 600
  changed lines; a bigger diff gets more, by the square root of its size
  (`src/limits.ts`):

  | Changed lines | ≤ 600 | 1,200 | 2,400 | 5,000 | 10,000 | 20,000 |
  |---|---:|---:|---:|---:|---:|---:|
  | `minor` (5) | 5 | 7 | 10 | 14 | 20 | 29 |
  | each category (3) | 3 | 4 | 6 | 9 | 12 | 17 |

  Each later review looks at the whole PR again for issues, but reports only
  new critical and major ones: a new round of small things on every push never
  ends. It looks for new improvements in what changed since the earlier review
  only, in proportion to its size: 3 per category per 600 changed lines, at
  least one when anything changed, and no more than a first review of that
  size. That is when the earlier review looked for improvements: after one
  whose improvements' agent failed, or one by an earlier version of this
  action, it looks for them in the whole PR, as a first review would. The agents are told to weigh a fix against its cost, and to suggest a
  follow-up rather than new machinery for an unlikely case. The job drops the
  findings past these limits (`resolve` in `src/memory.ts`). The job's log
  keeps them, in the review files. A problem the PR didn't bring is left out
  unless the PR makes it worse: a critical one is named in the summary, as
  pre-existing.
- **Improvements** are listed collapsed after the minor findings, by
  category, under their agent's summary, never as comments. With none, the
  review has its agent's summary in a line, or says why it didn't run.
- **While it runs**, a comment on the PR links to the sandbox's agent sessions
  on Atelier. The review replaces it. A review that fails, or is cancelled or
  times out with no newer push, leaves the comment saying so, as does one
  cancelled by a push to a PR that is a draft now (no run reviews a draft). The
  next run takes it over, and closing the PR deletes it (`src/progress.ts`).
- **It's an agent's opinion.** It comments, never approves or requests
  changes, and a finding can be wrong.
- **Each review follows from the earlier one** (`src/memory.ts`). Findings have
  ids (F1, F2…) that stay the same across reviews. A review hides in its body
  the findings still open, the ones dismissed and the head it saw. The next
  review gets them, the replies on each finding's thread, the PR's comments
  since (and every earlier one that names an open finding), and the diff since
  that head, on the PR's files only so that a rebase doesn't count. It rules on
  each earlier finding (fixed, still open, dismissed: *Since the review of* in
  its body), reviews what changed since in depth, then the whole PR again for
  issues. Each agent rules on its own kind of earlier findings. A force-push
  can drop the earlier head: that review then compares the findings with the
  head, without a delta, and looks for improvements in the whole PR.
- **To dismiss a finding**, reply on its thread that it's deferred, intended or
  won't be fixed. A minor finding or an improvement has no thread: comment on
  the PR with its id. The next review dismisses it without weighing the reason, which is the
  author's call. Only the PR's author and the repository's owners, its
  organization's members and its collaborators (GitHub's
  `author_association`) can: anyone else's comments don't reach the review.
- **Each review replaces the earlier ones.** Once it's posted, their summaries
  and comments are collapsed as outdated, not deleted, so the PR keeps every
  review. The job's log has each review file whole (`review file:`,
  `improvements file:`).
- **The sandbox** is destroyed after the review, or when the PR closes. Every
  review sandbox carries the PR in its metadata, so the PR's next run destroys
  any that a dead job left. Atelier can't destroy a sandbox still being created
  (a missing prebuild is baked first): the job waits up to 5 minutes for it to
  exist. The review step leaves its sandbox's id for the `cleanup-head` step,
  since Atelier doesn't list such a sandbox yet.

## Customise

- **Instructions.** `instructions`, and the file `instructions-file`
  (`REVIEW.md`) when the repository has one, are added to both agents'
  prompts: what to focus on or leave out, how to write, the review's language.
  They can't replace them: the review files' schema, what the severities and
  categories mean, the limits on findings and "change nothing" are what the
  job relies on. The file is read on the PR's target branch, so a PR can't
  change the rules it's reviewed by: a change to it applies once merged. The
  agents also read the repository's AGENTS.md files, at the PR's head.
- **What it reports.** `allowed-findings`, one `kind: number` per line or
  comma-separated, on top of the defaults:

  ```yaml
  allowed-findings: |
    minor: 8
    performance: 5
    conventions: 0
  ```

  A kind at 0 is not reported, and its category not looked for: the issues'
  agent keeps it then. With `performance`, `duplication` and `conventions` all
  at 0, the improvements' agent doesn't run. The next review dismisses the
  open improvements of a category turned off.
- **The sandbox's size.** `vcpus` and `memory-mb`: both agents and their
  sub-agents run in it at once, each a pi process.
- **The sub-agents' model.** `reviewer-model` is given to each sub-agent of
  both agents (pi-subagents' `model`, `provider/model`). The org's secrets need that
  provider's key: a sub-agent that can't start leaves its part unreviewed, and
  the review's summary says so.
- **The agents' model** is their toolbox's, not the action's: Atelier has no
  call to pick one, and both agents run on it. Make a toolbox whose pi settings file sets it and pass it in
  `toolboxes`. A toolbox listed there comes after the org's auto-included ones,
  so its file at the same path wins. Toolboxes are applied at boot and don't
  change which prebuild the sandbox boots from.

## Measure

`src/stats.ts` counts what became of the findings on a repository's merged
PRs, per severity of issue and per category of improvement: fixed, dismissed,
or still open at merge, and how many reviews each PR took. It reads the state each review hides, nothing else, so it
counts PRs merged before it was run too:

```sh
GITHUB_TOKEN=$(gh auth token) bun actions/agent-review/src/stats.ts owner/repo 200
```

The number is how many closed PRs to read (100 by default). It prints a
markdown table, which a scheduled workflow can append to
`$GITHUB_STEP_SUMMARY`. *Fixed* is the agent's ruling at the review after the
fix, not a person's. Many findings dismissed is noise, worth a line in
`REVIEW.md`, or a lower number in `allowed-findings` for their kind. A share
fixed that drops after a change to the prompts, the models, `subagents` or
`allowed-findings` says the change made reviews worse.

## Security

- Whoever can push a branch to the repository runs code in the reviewer's
  sandbox, with the org's secrets, as with any CI job that holds secrets.
- Comments from people outside the repository (on a public one) don't reach the
  agent: they could dismiss a finding or steer it.
- What the agent writes is untrusted: a PR can try to steer it. The job only
  posts it as a comment. Its @mentions notify no one, its raw HTML is shown as
  text, and its open code fences are closed (`quiet` in
  `../shared/src/markdown.ts`).
- The sandbox's GitHub token should be read only (*Setup on Atelier*, step 3).

## Run it locally

A dry run reviews a PR and prints the review instead of posting it, and leaves
the PR's comments alone. Its sandboxes are apart from the CI's (their own name
and metadata), so neither destroys the other's. Any token that reads the PR will do:

```sh
ATELIER_URL=https://atelier.example.com ATELIER_API_KEY=atl_... \
  GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=owner/repo PR_NUMBER=42 \
  bun actions/agent-review/src/main.ts dry-run
```

## Develop

The action runs `src/main.ts` with Bun, with no install and no build: the
code has no dependency. It shares Atelier's MCP client, the GitHub client and
the job's helpers with the [dependency update](../agent-bump/README.md), from
`../shared/src/`, imported by relative path: a workflow that uses the action
gets the whole repository. Its tests run with the rest (`bun run test` at the
repository's root), and CI shellchecks `src/diff-files.sh`.

Later runs read back the markers the action leaves in reviews and comments
(`<!-- agent-review-... -->`). Changing one makes every open PR forget its
earlier reviews.
