# Using Atelier as an agent UI's remote compute

An agent UI (Steery, the opencode IDE, Orca) drives Atelier sandboxes through
the public API, from its own client side: a Rust adapter, a plugin, a desktop
recipe. Atelier runs no UI agent and has no server-side hook for it. This page
is the contract such a client adapter builds on. See [README.md](README.md) for
what an integration is, and [steery.md](steery.md) for the one that ships.

## The API

Authenticate with `Authorization: Bearer <key>`: a normal API key (Settings →
API keys). It has its owner's access, the sandboxes they can reach, so use a
dedicated key per UI and revoke it to cut that UI off.

| Need | Call |
|------|------|
| Create, from an image, snapshot or git repo | `POST /v1/sandboxes` (`202` job); `repo: {url, branch?}` boots a repo |
| Wait for a create | `GET /v1/jobs/:id`; the sandbox id is `job.metadata.sandboxId` |
| List own sandboxes | `GET /v1/sandboxes?owner=me&metadata=<JSON>` |
| Status, URLs, processes | `GET /v1/sandboxes/:id` |
| Fork | `POST /v1/sandboxes/:id/fork` (`202` job, owned by the caller) |
| Pause, resume, destroy | `POST /v1/sandboxes/:id/pause`, `.../resume`, `DELETE /v1/sandboxes/:id` |
| Run a command | `POST /v1/sandboxes/:id/exec` |
| Files | `PATCH /v1/sandboxes/:id/files` |
| Ports | `POST /v1/sandboxes/:id/ports`; public ones are in `urls` |
| Interactive channel | SSH: register a key with `POST /api/ssh-keys`, then `ssh <sandboxId>@<host> -p <port>` (the `ssh` entry of `urls`) |
| Default image | `GET /api/config`: the `value` of the entry whose `key` is `sandbox.defaultImage` |

Right after a `202`, `GET /v1/sandboxes/:id` can still 404: the record appears
once the job has resolved the source, so follow the job.

### Ensure, client side

There is no server-side get-or-create. A client "ensure my host" is:

1. Label the sandbox at create: `metadata: {"myui/host": "<key>"}` in the
   `POST /v1/sandboxes` body.
2. Next time, list `GET /v1/sandboxes?owner=me&metadata={"myui/host":"<key>"}`
   (URL-encoded) and re-check the labels client-side.
3. Use the match (resume it if `paused`), else create.

Two ensures running at once can both miss and create two sandboxes: serialize
them in the client. A sandbox in `error` stays listed until deleted.

### Create from a repo

`repo: {url, branch?}` on the create body boots from a git repo. An existing
bake of that repo and branch (on the same base image) is reused, otherwise a
one-repo prebuild is baked on `source.image` (required with `repo`) using the
owner's GitHub token. `repo` together with `prebuild` or a `source.snapshot`
is a 400. The server cannot know a repo's default branch, so an omitted
`branch` and an explicit `main` are different bakes: send the same spelling
every time.

## What each UI needs from it

opencode's workspace APIs are **experimental upstream** and move: pin a
version.

| Need | opencode v1 `WorkspaceAdaptor` | opencode v2 `WorkspaceDriver` | Orca `environmentRecipes` | Atelier |
|------|-------------------------------|-------------------------------|---------------------------|---------|
| ensure | `create(info, env, from?)` | `create({workspaceID})`, idempotent per id | `create` script prints the target JSON | list by label, else `POST /v1/sandboxes` |
| fork | `from?` | none | none | `POST /v1/sandboxes/:id/fork` |
| list | `list?()` | none | none | `GET /v1/sandboxes?owner=me&metadata=` |
| pause / resume | none | `suspendForIdle`; wake in `connect` | `suspend` / `resume` scripts | `POST .../pause`, `.../resume` |
| destroy | `remove(info)` | `destroy({workspaceID, binding})` | `destroy` script | `DELETE /v1/sandboxes/:id` |
| exec | provider starts `opencode serve` | `EnvironmentDriver.spawner` | host-side over SSH | `POST .../exec`, or SSH |
| files | via the remote opencode API | `FilesImpl` over the spawner | host-side over SSH | `PATCH .../files`, or SSH |
| target | `{type: "remote", url, headers}`: the opencode server in the sandbox, behind a public port | the spawner above | SSH: host, port, username, identity file | `urls` (public ports with `ports`), `ssh` |

Sources: opencode v1 `control-plane/types.ts` (b6478dce), `server/workspace.ts`
(51e310c9); opencode v2 `packages/core/src/workspace/driver.ts` and
`environment/driver.ts` (dev), issue #45612; Orca "Ways to run Orca", "SSH
worktrees" and the `orca-per-workspace-env` skill guide (main, unpinned:
re-check the stdin and JSON schema). Orca, opencode and Steery run their own
agents and answer their own agents' approvals; Atelier only pushes the
approvals of Atelier-driven sessions (see README).

## Orca: an SSH recipe (untested)

Orca runs recipe scripts on the desktop and reads one JSON object from
`create`'s stdout. Map an Orca workspace to a sandbox labelled with the repo
and branch: ensure it over the routes above (`atelier up` cannot set
metadata, so create with `POST /v1/sandboxes` and `repo`). Then
`atelier resume <id>` wakes a paused one, `atelier ssh <id> --print` gives the
SSH target, and `atelier rm <id>` is the `destroy` script. Prerequisites:
`atelier context add` done and `atelier ssh-key setup` run (it writes
`~/.ssh/atelier_ed25519` and registers it). This mapping has **not been run
against Orca**.
