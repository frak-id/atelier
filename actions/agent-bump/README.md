# Agent dependency update

A GitHub Action that has a coding agent update a repository's dependencies in
an Atelier sandbox, on a schedule, and open the result as one pull request.

The job starts a sandbox from the repository's prebuild, at the base branch's
head, as an Atelier [service account](../../docs/service-accounts.md). The
sandbox's coding agent (pi) runs the repository's checks first, then finds
what's outdated in every ecosystem: packages, toolchains, container images,
GitHub Actions, versions pinned in Dockerfiles. For each update it reads the
release notes between the two versions, migrates the configuration, replaces
what the new version deprecates, runs the checks again and commits. What it
can't make pass it undoes and holds back, saying why. The job checks its
commits, pushes the branch and opens the pull request from the sandbox, with
the account's GitHub credential, then destroys the sandbox.

## Usage

```yaml
name: Dependency update

on:
  schedule:
    - cron: "0 5 * * 1" # Mondays, 05:00 UTC
  workflow_dispatch:

permissions:
  contents: read

# One update at a time: a run started by hand waits for the scheduled one.
concurrency:
  group: agent-bump
  cancel-in-progress: false

jobs:
  update:
    runs-on: ubuntu-latest
    # The sandbox's boot (10 minutes at most), the agent (90), the push.
    timeout-minutes: 120
    # The job's token only reads: the service account's credential writes.
    permissions:
      contents: read
      pull-requests: read
    steps:
      - uses: frak-id/atelier/actions/agent-bump@main
        with:
          atelier-url: https://atelier.example.com
          api-key: ${{ secrets.ATELIER_BUMP_API_KEY }}
      # Cancelled mid-update (by hand, the timeout): the step above could not
      # destroy its sandbox. This one does.
      - if: cancelled()
        uses: frak-id/atelier/actions/agent-bump@main
        with:
          atelier-url: https://atelier.example.com
          api-key: ${{ secrets.ATELIER_BUMP_API_KEY }}
          mode: cleanup
```

Pin a release tag or a commit SHA instead of `@main` to choose when the action
changes.

### Inputs

| Input | Default | What it is |
|-------|---------|------------|
| `atelier-url` | required | Base URL of the Atelier server |
| `api-key` | required | The service account's API key (`mcp` scope), from a secret |
| `mode` | `bump` | `cleanup` destroys the sandbox of a cancelled update: it goes in the `if: cancelled()` step |
| `base` | the default branch | Branch the update starts from and targets |
| `branch` | `agent-bump` | Branch that carries the update (*How an update goes*) |
| `image` | `dev-base` | Base image the sandbox boots on. Atelier reuses the repository's prebuild on it |
| `minimum-release-age` | `3` | Days a release must have been out before the agent takes it |
| `subagents` | `auto` | `auto`: sub-agents read the release notes when there are more than 6 updates. `always` or `never` to choose |
| `subagent-model` | | The sub-agents' model, `provider/model` as pi-subagents names it |
| `toolboxes` | | Toolboxes on top of the org's auto-included ones, comma- or line-separated selectors |
| `instructions` | | Text added to the agent's prompt (*Customise*) |
| `instructions-file` | `DEPENDENCIES.md` | Instructions read on the base branch, when the file is there. Empty to read none |
| `labels` | | Labels for the pull request, comma- or line-separated. They must exist |
| `agent-timeout-minutes` | `90` | The agent's time for one update. Give the job about 30 minutes more |
| `bun-version` | `1.4.4` | Bun version the action runs on |

## Setup on Atelier

1. **An org for the updater.** A service account gets every secret of its
   org. Its sandboxes run the new releases' code (install scripts, builds,
   tests) with those secrets and with a GitHub credential that can push. Give
   it an org that holds only what the update needs, such as the model key, and
   not the reviewer's org.
2. **Its coding agent.** With `subagents` other than `never`, the agent hands
   the release notes to pi-subagents' built-in `scout`, so the org's sandboxes
   need pi with [pi-subagents](https://github.com/nicobailon/pi-subagents). The
   console's Library suggests a pi toolbox that has it. Make it auto-included
   in the org.
3. **A service account** in that org, with a GitHub credential that can push
   and open pull requests. For a GitHub App installed on the repository only,
   narrow its token with
   `"permissions": { "contents": "write", "pull_requests": "write", "workflows": "write", "metadata": "read" }`.
   Without `workflows`, GitHub refuses a push that changes
   `.github/workflows/`: the run fails and says so. Say in `DEPENDENCIES.md`
   to leave GitHub Actions alone, or grant it.
4. **A rule on the base branch** that requires a pull request and a review,
   without a bypass for the App. The credential can push to any branch no rule
   protects, and the agent holds it. A rule that requires signed commits
   refuses the update's: they're made with git in the sandbox, unsigned.
5. **An API key** for the account, with the `mcp` scope (the default for a
   service account). Store it as an Actions secret of the repository. On
   GitHub's free plan, an organization secret reaches a private repository's
   workflows as an empty string.
6. **A prebuild of the repository** on the `image`, of the base branch.
   Without one, the first update bakes it, which can take longer than the 10
   minutes a sandbox has to boot.

The pull request is opened by the service account's GitHub identity, not by
the job's `GITHUB_TOKEN`, so the repository's workflows run on it: CI, and
[agent review](../agent-review/README.md) if it's set up. A pull request
opened with `GITHUB_TOKEN` starts no workflow.

People in the account's org can watch the agent work: the run's annotations
link to the sandbox's session in the console (sign in with GitHub).

## How an update goes

- **Before anything**, the job looks at the update's branch. It replaces a
  branch only at the head it pushed itself, as the newest pull request from
  the branch records in its body. Once a person pushes to it, the update is
  theirs: runs stop with a notice until its pull request is merged or closed.
  A branch of that name the job never pushed stops them too.
- **The agent** works in a clone at the base branch's head, on the update's
  branch (`src/prompt.ts`). It runs the checks before changing anything, so
  that a check already failing on the base isn't blamed on an update. It takes
  the newest stable release at least `minimum-release-age` days old, no
  pre-release, and a major one only when it can migrate now. What is released
  together moves together: a framework and its plugins, a package and its
  `@types`, the same tool in a Dockerfile and a workflow. It reads every
  release's notes between the two versions, then makes the changes they call
  for, and only those: a renamed config key, a new schema version, a
  deprecated API replaced, the tool's own migration (`biome migrate`). Each
  update, or each group that moves together, is one commit, made once the
  checks pass, so that one can be reverted alone. It doesn't push.
- **The job then checks** the agent's file (`src/bump-file.ts`) and its
  commits: on the update's branch, on top of the base, nothing left out of
  them. Once more, in the same context, the agent gets to fix either. Then the
  job pushes the branch from the sandbox, with a lease on the head it saw at
  the start: a push to the branch since isn't overwritten. Then it opens the
  pull request, or updates the one open, with `gh`. The run's log has the
  agent's whole file (`result file:`), and its summary has the body.
- **The pull request** (`src/pull-request.ts`) has the agent's summary, a
  table of the updates, majors first, with a link to the release notes it
  read, what each update took, what it held back and why, and the checks. A
  check that passes on the base and fails on the update makes it a draft. The
  agent is told to undo such an update, so a draft is a slip worth a look.
- **Run after run, one pull request.** Each run starts again from the base
  branch's head and force-pushes the branch, so an update left open stays one
  pull request, up to date. People's comments on it reach the next run: one
  asking to hold a dependency holds it, as long as that pull request is open.
  Only the repository's owners, its organization's members and its
  collaborators count (GitHub's `author_association`). To hold a dependency
  for good, write it in `DEPENDENCIES.md`.
- **Nothing to update**: no push and no pull request. One still open is left
  as it is.

## Customise

- **Instructions.** `instructions`, and the file `instructions-file`
  (`DEPENDENCIES.md`) when the repository has one, are added to the agent's
  prompt: dependencies to hold or pin and why, ecosystems to leave out, majors
  to leave to people, checks that need more than the scripts. They can't
  change the result file's schema, or that the agent commits only on the
  update's branch and never pushes. The file is read on the base branch, so
  the update can't change its own rules. For example:

  ```markdown
  - Hold `zod` on 3.x: the API's validation messages are part of its contract.
  - Leave the Kubernetes manifests' images alone: they're bumped at deploy.
  - Bun: the same version in `package.json`, the Dockerfile and `action.yml`.
  ```

- **The sub-agents' model.** `subagent-model` is given to each sub-agent
  (pi-subagents' `model`, `provider/model`). The org's secrets need that
  provider's key.
- **The agent's model** is its toolbox's, not the action's: make a toolbox
  whose pi settings file sets it and pass it in `toolboxes`.

## Security

- The new releases' code runs in the sandbox: install scripts, builds, tests.
  It runs with the org's secrets and the account's GitHub credential. A
  compromised release can use them. `minimum-release-age` narrows that window
  (such releases are usually pulled within days), but doesn't close it: keep
  the org's secrets and the credential's reach to what the update needs.
- Release notes are text from outside the repository, and the agent reads
  them. It's told they're data, but a page can try to steer it, and it holds a
  credential that can push. What it pushes reaches the base branch only
  through a pull request that a person reviews (*Setup*, step 4). The job
  checks where the commits are, not what they do: that's the review's job.
- Comments from people outside the repository don't reach the agent.
- What the agent writes goes into the body quieted: its @mentions notify no
  one, its raw HTML is shown as text, its open code fences are closed
  (`quiet` in `../shared/src/markdown.ts`).

## Run it locally

A dry run updates in a sandbox and prints the pull request instead of pushing
it. Its sandboxes are apart from the CI's (their own metadata), so neither
destroys the other's. Any token that reads the repository will do:

```sh
ATELIER_URL=https://atelier.example.com ATELIER_API_KEY=atl_... \
  GITHUB_TOKEN=$(gh auth token) GITHUB_REPOSITORY=owner/repo \
  bun actions/agent-bump/src/main.ts dry-run
```

## Develop

The action runs `src/main.ts` with Bun, with no install and no build: the code
has no dependency. It shares Atelier's MCP client, the GitHub client and the
job's helpers with agent review, from `../shared/src/`, imported by relative
path: a workflow that uses the action gets the whole repository. Its tests run
with the rest (`bun run test` at the repository's root).

The job reads back the state it hides in the pull request's body
(`<!-- agent-bump-state ... -->`). Changing it makes the next run take the open
pull request for a person's, and leave it alone.
