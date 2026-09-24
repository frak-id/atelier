# Launchpad — a non-technical surface over Atelier

> Status: **v1 implemented** on `feat/launchpad`.
> Code: contract `packages/spec/src/launchpad-spec.ts` · storage
> `apps/server/src/control/modules/launchpad/` (migration `0023_launchpad`) ·
> seam `apps/server/src/api/launchpad.lifecycle.ts` (routes:
> `launchpad.routes.ts`) · console
> `routes/launchpad.*`, `routes/settings.launchpad.*`, `components/launchpad/`.
> Roadmap: §6 "In-console examples — a dev companion for the product team".

## 1. Problem

Atelier is built for developers: specs, prebuilds, toolboxes, terminals. The
product, design, marketing and support teams could use the same sandboxes
(an agent web UI like pi-web on a prebuilt repo, a live preview of the app,
an admin panel), but today they would land on a JSONC editor.

The dev team should be able to **prepare** a ready-to-use environment
(prebuild + toolboxes + context + the services to open) once, and everyone
else should **consume** it with one click, without seeing any of that.

## 2. Shape

Two roles, two entities, one new surface.

| Concept | Who | What |
|---|---|---|
| **Starter** | dev team (authors) | A curated, named recipe: title, description, icon, the `CreateSandboxRequest` to boot, the **services** to surface, an optional short guide. Org- or user-owned, same owner model as toolboxes. |
| **Workspace** | anyone (consumers) | A sandbox launched from a starter, with a user-editable title + description, plus a snapshot of the starter's presentation (services, guide, icon) taken at launch. |
| **Launchpad** (`/launchpad`) | anyone | "What are you working on?" + the starters grid; "Jump back in" with the caller's workspaces. |
| **Workspace view** (`/launchpad/w/$id`) | anyone | Plain-English status, one tile per service (open in-page as an iframe, or in a new tab), the guide, rename/describe, sleep/wake/delete. |

The home page (`/`) gets a large banner pointing non-developers to the
Launchpad, and the header gains a Launchpad entry.

### Out of scope for v1 (deliberate)

- **No chat UI.** A starter surfaces whatever the tech team exposes: pi-web,
  opencode's web UI, a dev server, code-server. The ACP session surface stays
  on the developer console.
- No "save this sandbox as a starter" from a sandbox page, no CLI/MCP surface,
  no sharing of a workspace between users, no parameterized starters
  (`repo-url` params from `design/ui-evolution.md` §2.2). All additive later.

## 3. Prior art

- **Coder `coder_app`**: `slug`, `display_name`, `icon`, `url`, `external`,
  `open_in` (`tab` | `slim-window`), `order`, `group`, `hidden`, and a
  `healthcheck`. Services in this proposal are the same idea, cut down:
  label, icon, port-or-URL, open mode, order = list order.
- **Gitpod `ports[].onOpen`** (`open-preview` | `open-browser` | `notify` |
  `ignore`) and **devcontainer `portsAttributes.label`/`onAutoForward`**: the
  author decides in the recipe whether a port opens in the editor preview or
  in the browser. Here that's `open: "embed" | "external"`.
- **Iframes**: an app that sends `X-Frame-Options: DENY` or a restrictive
  `frame-ancestors` CSP can't be embedded, and the browser gives the parent
  page no reliable, cross-origin way to detect that. So the author declares
  `open: "external"` for those services, and the UI **always** shows an
  "open in a new tab" action next to the embedded view.

## 4. Design decisions

### 4.1 Starter = control-plane data, recipe = `CreateSandboxRequest`

A starter stores a full `CreateSandboxRequest` (`recipe`). A recipe that uses
a `prebuild` *recipe* (not a pinned `source.snapshot`) follows prebuild
updates: the seam re-resolves it on every launch, and it's a cache hit when
nothing changed (`create-request.ts`).

Launch is **server-authoritative**: the consumer sends only `{ title?,
description? }`. The server reads the stored recipe, stamps
`atelier.dev/launchpad-*` annotations and metadata, and runs the exact same
`createSandboxForUser` seam as `POST /v1/sandboxes` (enrichment, toolboxes,
org policy, git attribution). A non-technical caller never supplies a spec.

### 4.2 Services

```ts
{
  id: "preview",               // stable key, kebab-case
  label: "Live preview",
  description?: "See your changes as you make them",
  icon?: "eye",                 // curated lucide key, see LAUNCHPAD_ICONS
  target: { port: "web", path?: "/admin" } | { url: "https://…" },
  open?: "embed" | "external",  // default embed
}
```

- A `port` target is resolved against the sandbox's `urls[]` by port name.
  It carries the gating processes and readiness that `useServiceGate`
  already understands. `path` is appended.
- A `url` target is a static link (staging, docs, a Figma file). A
  `{sandboxId}` placeholder in it is substituted, so it can also point to a
  preview environment keyed by the sandbox.
- **Lazy tools start when opened.** A port's gating processes (a toolbox's
  pi-web or code-server, a prebuild's dev server) follow the one lazy
  workflow: `lazy: true` means "start on first access", and opening the
  tool is that access. The workspace page uses the developer console's
  service gate (`useServiceGate`) with `startOnOpen`, so the consumer never
  looks for a "Start" button; one only appears if a start failed. An
  `external` tool is started first, then offered as a link. Processes that
  aren't lazy start with the sandbox, as anywhere else.
- A starter with no services falls back to every public URL of the sandbox
  (except `ssh`), all embedded.

Resolution is a pure function in `@atelier/spec` (`resolveWorkspaceServices`),
so the server and the tests share one implementation.

### 4.3 Workspace = control row keyed by the sandbox id

`launchpad_workspaces(sandbox_id PK, user_id, starter_id, job_id, title,
description, snapshot JSON, created_at, updated_at)`.

- No FK to runtime (same rule as every control table). The sandbox id is
  pre-allocated at launch, like `POST /v1/sandboxes` does, so the row exists
  before the runtime record.
- Title and description are product data, not runtime mechanism, so they
  live in control, not in the runtime `metadata` blob. The runtime stays
  untouched.
- `snapshot` freezes the starter's title, icon, services and guide at launch.
  Editing or deleting a starter never breaks an existing workspace, and it
  stays consistent with the spec the sandbox actually booted.

**Status** is derived at read time in `api/` (the only layer that sees both)
from the runtime record and the workspace's latest lifecycle job (launch,
retry or wake-up; `jobId` always points at the newest):

| Runtime record | Latest job | Phase | Copy |
|---|---|---|---|
| running | any | `ready` | "Ready" |
| — | queued/running | `preparing` | "Setting things up…" |
| any other | queued/running | `starting` | "Starting…" / "Waking up…" |
| creating | settled | `starting` | "Starting…" |
| paused/stopped | settled | `sleeping` | "Sleeping" |
| error | settled | `failed` | "Something went wrong" |
| — | failed/canceled | `failed` | job error |
| — | succeeded / none | *(gone)* | row pruned: sandbox destroyed elsewhere |

The job wins while it's active because a resuming sandbox stays `paused`
until it's back. A failed wake-up restores `paused`, so the workspace reads
as asleep again. The pure mapping (`workspacePhase`) lives in `@atelier/spec`.

Retry: an `error` record resumes (the runtime's recovery path). A launch that
failed before the record existed is re-dispatched with the same id.

### 4.4 Authorization

- Starters: the same owner grammar as toolboxes (`owner=user|org:<id>`).
  Writes need org owner/admin (or self for user starters). The Launchpad
  lists the caller's own starters plus those of every org they belong to,
  published only.
- Launch requires read access to the starter (self, or org membership).
- Workspaces are owner-only through the Launchpad API. The developer
  console's `/v1` surface is unchanged: sandboxes are still globally visible
  there, a pre-existing product decision.

### 4.5 Console

- `/launchpad` and `/launchpad/w/$id` render inside a **lighter shell**: no
  developer nav or job indicator, a single "Developer console" link. The
  root layout switches shells by pathname.
- Starter authoring: **Settings → Launchpad** (list + page editor, using the
  toolbox editor's `SpecEditorShell` visual↔JSON pattern). The visual form
  covers presentation, services and the common recipe fields (boot source,
  toolboxes, resources). JSON mode exposes the whole recipe.
- **Boot source** (`StarterBootSource`; the recipe mapping is the pure,
  tested `lib/starter-recipe.ts`) is two modes, matching how a recipe
  is actually shaped (§4.1): **a stored prebuild** — pick any prebuild from
  `GET /v1/prebuilds` (labelled by `prebuildTitle`, so a multi-repo dev
  prebuild reads as `a + b` / `a + N more`), with a read-only summary of the
  repos it clones (`prebuildRepoLabel` + clone path) and its base image;
  follows the prebuild's own updates when it has a `spec` (`recipe.prebuild`
  set), else pins the snapshot ref (`recipe.source.snapshot`) for a hand-made
  snapshot with no spec — or **set it up here** — a base image plus **any
  number of git repositories** (URL, branch, clone path) and ordered setup
  steps, run from the home directory. With no repos and no steps this is
  just a plain image boot (`recipe.source`, no `recipe.prebuild`); with
  either, it's a full inline `PrebuildSpec` (`recipe.prebuild`, mirrored into
  `recipe.source`) — the same shape Settings → Prebuilds authors, just
  authored inline. A "Customize" action copies a selected stored prebuild's
  spec into the second mode as a one-off starting point. "Create a Launchpad
  starter" from a stored prebuild (`/settings/launchpad/new?prebuild=<ref>`)
  seeds the first mode with that prebuild, title `Work on <prebuildTitle>`.

- **Dev servers become tools.** A prebuild declares its projects' dev
  servers in the toolbox scheme (`processes` + `ports`, several for a
  monorepo), on a stored prebuild or in "Set it up here". Its public ports
  are suggested first when adding a tool: point a "Preview" tile at one,
  and opening it starts the (lazy) dev server.

## 5. API

```
GET    /api/launchpad/starters?owner=…          authoring list (owner-scoped)
POST   /api/launchpad/starters?owner=…          create
PATCH  /api/launchpad/starters/:id              update (stored-owner authz; `null` clears icon/guide)
DELETE /api/launchpad/starters/:id
GET    /api/launchpad/catalog                   published starters visible to the caller
POST   /api/launchpad/starters/:id/launch       { title?, description? } → Workspace (202)
GET    /api/launchpad/workspaces                caller's workspaces + phase
GET    /api/launchpad/workspaces/:id            + resolved services (live readiness)
PATCH  /api/launchpad/workspaces/:id            { title?, description? }
POST   /api/launchpad/workspaces/:id/sleep      pause
POST   /api/launchpad/workspaces/:id/wake       resume (+ git creds refresh)
POST   /api/launchpad/workspaces/:id/retry      resume in place, or relaunch (same launch authz)
DELETE /api/launchpad/workspaces/:id            destroy sandbox + row (already gone = fine)
```

## 6. Known limits (v1)

- **Repos are cloned at bake time with the launcher's GitHub token.** A
  starter's inline `recipe.prebuild.repos` clone exactly like a Settings →
  Prebuilds repo: the launcher who first bakes it (or triggers a rebake
  after a push) needs read access to every repo it lists, via their own
  GitHub token — the same seam `createSandboxForUser` already resolves
  prebuilds through (`apps/server/src/api/v1.routes.ts`). Clones are shallow
  (`git clone --depth 1`), and the content key includes each repo's current
  remote HEAD, so a push busts the cache and the next launch re-bakes
  (`apps/server/src/runtime/runtime.service.ts`). Once booted, every sandbox
  gets its own github.com credential helper + ssh→https rewrite
  (`git-attribution.ts`), so `git pull`/`git push` from inside the workspace
  work with the CURRENT user's token, independent of who baked it.
- **Org secrets resolve against the launcher's first org** (the existing
  `resolveOrgId` Phase 0 simplification). An org starter launched by a
  member of several orgs can pick up the wrong org's secrets and policy
  until the multi-org header lands.
- **Workspaces are private to their launcher.** The developer console still
  lists every sandbox (unchanged `/v1` behavior), with a "Launchpad" badge
  read from the `atelier.dev/launchpad-starter` annotation.
- **Embeddability can't be auto-detected.** The author picks
  embed/external per tool, and "open in a new tab" is always offered.
  Embedded frames are sandboxed without top-navigation: an author-chosen
  URL can't navigate the Launchpad away.
- **Opening a tool starts its gating processes only** (`gatingProcessNames`,
  the runtime's rule). A tool whose web process needs a sibling started
  first relies on that process's `after` dependency (see
  `design/ui-evolution.md` §3.3, pi-web).

## 7. Follow-ups

- "Publish as starter" from a running sandbox (the highest-leverage authoring
  entry point, `ui-evolution.md` §6).
- Parameterized starters (repo/branch picker for the consumer).
- Idle auto-sleep for Launchpad workspaces (non-technical users won't pause).
- Workspace sharing ("send this preview to a colleague").
- CLI/MCP parity (`atelier launchpad …`).
