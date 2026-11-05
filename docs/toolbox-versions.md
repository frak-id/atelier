# Toolbox-Associated Toolset Versions ("Save toolset for toolbox")

Status: **implemented**. §10 (refresh) and §11 (ownership, files, transfer)
were added later.

Lets an operator spawn a sandbox from a toolbox, tune a tool's config live in
that sandbox, then **save that live state back as a new, named version of the
toolbox's toolset** — kept associated with the toolbox so future spawns can use
it, with rollback. Design distilled from a design consult (oracle) plus the
current code; references point at the real entities.

---

## 1. Background — what exists today

Two artifacts, on two sides of the runtime seam:

- **Toolbox** — control-plane DB entity (`toolboxes`,
  `apps/server/src/control/db/schema.ts`), owned by an org (`org_id`; see §11).
  Fields: `{ slug, description, source?, build[], paths[], harness?, processes?,
  ports?, files?, autoInject }`. It is the editable **recipe**: `source` = git/image,
  `build[]` = shell steps (e.g. `npm install -g --prefix ~/.local
  @earendil-works/pi-coding-agent pi-acp @jmfederico/pi-web`), `paths[]` =
  home-relative paths to capture into the artifact.

- **Toolset** — the built, **immutable** OCI artifact in the Zot registry.
  Runtime-plane record (`ToolsetRecord`, `apps/server/src/runtime/store.ts`):
  `{ hash, name, ref, paths, provenance, private, createdAt }`. Two provenance
  kinds (`apps/server/src/runtime/runtime.service.ts`):
  - `built`: **input-keyed**. `hash = sha256({name, source, build, paths})`
    (`hashToolset`). Idempotent + inflight-deduped. Runs `build[]` in a
    throwaway `dev-base` pod as `dev`, then `oras push` of `paths[]`.
  - `captured`: **result-keyed**. `ToolboxOps` asks the runtime
    (`runtime.captureToolset`) to tar the **live** paths out of a running
    sandbox, secret-scan and push them. There is no standalone capture route:
    capture happens through a toolbox (§7). `hash = digest` (no pre-image),
    `private: true`, `provenance:{kind:"captured", capturedFrom}`.

At spawn (`ToolboxOps.resolveForSpawn`, `apps/server/src/api/app/toolbox-ops.ts`),
for each applied toolbox the server calls `buildToolset({name:"tb/<toolboxId>",
source, build, paths})` **fresh every spawn** (no memo; relies on the
content-hash cache). The resulting `ToolsetRef`s are prepended to
`SandboxSpec.toolsets`, which the agent materializes into `$HOME` at boot.

**The gap:** a toolbox always resolves to its recipe-built toolset. Captured
toolsets are orphan one-offs — no toolbox linkage, no description beyond a name,
not visible as "a version of X", never re-used by a future spawn.

Two tensions that shape the design:

- Recipe builds are **content-keyed & reproducible**; captures are
  **result-keyed & mutable snapshots**. Different identity models.
- Build steps are often **unpinned** (`npm i -g pkg` = latest), so the recipe
  hash does not change when upstream releases — the cached toolset freezes the
  installed version until a `build[]` string changes.

---

## 2. Conceptual model — versions of the *deliverable*, pinned on the toolbox

Reframe: **a toolbox is a recipe + a stream of versioned deliverables.** Today
the deliverable is implicit (whatever `hashToolset(...)` resolves to). Make it
explicit and versionable.

- A **toolbox version** is a row associated with the toolbox:
  `{ ref, label, description, provenance }`. A capture is a legitimate version
  of the toolbox's deliverable **provided it captures the toolbox's own
  `paths[]` contract** (see the invariant below).
- The toolbox gains an **active pin**: a nullable `active_version_id`.
  - Pin set → `resolveForSpawn` returns the pinned `ref` directly and
    **skips `buildToolset` entirely**.
  - Pin null → today's behavior (recipe build, content-hash cached),
    byte-for-byte unchanged.

Use a **pin pointer**, not "list, newest wins". An explicit pin makes rollback a
repoint, makes "unpin → back to recipe" a first-class state, and keeps the
recipe path as the default rather than an afterthought.

Do **not** model this as "capture mutates the toolbox's toolset". Refs are
immutable digests and must stay that way — only the pointer moves.

### Critical invariant: capture the toolbox's own `paths[]`

A capture-for-toolbox must capture **the toolbox's `paths[]`** (server-derived,
not caller-supplied). Otherwise a "version" is not substitutable for the
recipe-built artifact and the abstraction collapses. The console passes only
`{ sandboxId, description }`; the server resolves `paths` / `exclude` from the
toolbox config. (User-added extra paths can come later as an explicit `paths`
*extension* on the toolbox, then capture — not in the first cut.)

---

## 3. Recipe vs capture reconciliation

- **A pinned capture shadows the recipe; `build[]` is never dead.** It remains
  (a) the fallback when unpinned, (b) the documentation of intent, (c) the
  rebase base. Dropping `build[]` after a capture would turn every toolbox into
  an unreproducible blob, one save at a time.
- **Recipe edit while pinned: do NOT auto-unpin.** Predictability wins — pinning
  v3 must not be silently unseated by a description-adjacent edit. Instead store
  `recipeHash = hashToolset(...)` on the version row at pin time and surface a
  **"recipe changed since pin"** badge in the console (compare stored vs
  current). The user then chooses: keep the pin, or unpin → rebuild.
- **Record recipe-built artifacts as version rows too**, lazily — on the first
  successful build per `recipeHash`, insert a row with `provenance: built`. Then
  the version history is complete: you can roll back from a capture to "the
  recipe build as of last month" without re-deriving anything.

---

## 4. Schema — one control-plane table + one column

Keep the linkage **control-plane**. The runtime `ToolsetRecord` store must not
learn about toolboxes — it is below the seam (`runtime/` never sees control
entities, same boundary rule as harness names). The settings "toolset details"
view joins version rows to runtime records by `ref`.

```
toolbox_versions:
  id            text PK
  toolbox_id    text  FK → toolboxes.id   (indexed)
  label         integer     -- monotonic per toolbox: v1, v2, …
  ref           text        -- toolsets/tb/<toolboxId>@sha256:…
  description   text
  provenance    text json   -- {kind:"captured", capturedFrom, capturedBy}
                            -- | {kind:"built", recipeHash, sourceImageDigest}
  created_at    text

toolboxes:
  + active_version_id  text  nullable   -- FK → toolbox_versions.id
```

- Do **not** put `description` on the runtime toolset record — it is a
  human/control concern, and the same `ref` could back versions of two
  toolboxes.
- `label` is a per-toolbox monotonic counter (`max(label)+1`), not a global
  sequence, so version numbers read naturally per toolbox.

---

## 5. Drift & reproducibility — where this bites

Capture-as-pin is fine; capture-as-the-only-story is dangerous.

- **Secrets (the big one).** `~/.pi/agent/settings.json` / cliproxy plugin
  config hold API keys. The capture secret-scan + `exclude` help, but a pinned
  capture on an **auto-inject** toolbox replays into *every future spawn* — and
  if org-owned, to *every user*. Guards:
  - captures stay `private: true` by default;
  - require the existing explicit publish step before an **org-owned** pin;
  - run the scan with the toolbox's excludes and **hard-fail (not warn)** on
    findings for a path destined to be pinned.
- **Native binaries vs base image.** A pi capture contains `node-pty` compiled
  against `dev-base`'s Node 22. Bump `dev-base` to Node 24 → the pinned capture
  can segfault while the recipe would have rebuilt cleanly. Record the source
  **image digest** in capture provenance and badge "captured against older base"
  when `config.sandbox.defaultImage` moves.
- **Live-state junk.** Caches, logs, sessions, sockets (`~/.pi-web/
  sessiond.sock`!) inside `paths[]`. The `exclude` machinery exists; the
  toolbox-derived excludes must cover it.
- **The durable answer is still the recipe.** Treat capture as "quick save".
  The console should nudge *version* bumps (pi X.Y.Z) toward **editing `build[]`
  with pinned package versions**, not capturing an in-sandbox `npm update`.
  Long-term north star: "diff a capture → suggest a recipe edit". Not in the first cut.

---

## 6. Failure & UX edges

- **Who can capture-for-toolbox?** A member of the toolbox's org. Trap: a
  member capturing a shared toolbox and pinning it org-wide ships their
  personal config (and creds) to everyone. The publish-before-pin guard (§5)
  covers it: a private capture cannot be pinned until it is published. To
  personalize, capture into a toolbox of your **personal org**.
- **Concurrent captures**: harmless. Captures are result-keyed; each is a
  distinct version row; last pin wins. No dedup needed.
- **GC / retention**: never GC the active pin or the latest `built` row. Keep
  the last N (say 10) versions per toolbox; beyond that, delete the runtime
  record + registry-untag (Zot retention handles the blobs).
- **Rollback**: repoint `active_version_id`. Free, instant — the reason to
  prefer the pin model.
- **Sandbox deleted after capture**: fine. `capturedFrom` is provenance, not a
  live dependency.

---

## 7. Recommended first cut (small, corner-free)

1. **Migration**: `toolbox_versions` table + `active_version_id` column
   on `toolboxes`.
2. **Capture endpoint**: `POST /api/toolboxes/:id/versions/capture
   { sandboxId, description }`. Server derives `name` / `paths` / `exclude` from
   the toolbox config, calls the existing `runtime.captureToolset`, inserts a
   row with `label = max+1`. **Does not auto-pin** — returns the row. Pinning is
   a second, explicit call.
3. **Pin endpoint**: `PUT /api/toolboxes/:id/active-version { versionId | null }`.
   Sets/clears `active_version_id`; records `recipeHash` at pin time.
4. **Resolution**: in `ToolboxOps.resolveForSpawn`, if the
   config has an active version → push its `ref` and **skip the build** (keep
   the existing try/catch skip-on-failure semantics).
5. **Console**:
   - toolbox settings → versions list (label, description, provenance kind,
     created, active marker, pin / rollback);
   - sandbox page → **"Save toolset for toolbox"** (enabled when the sandbox's
     applied toolboxes are known — `applied` refs are already threaded at spawn;
     persist them on the sandbox record if not already);
   - "recipe drifted since pin" badge from the stored `recipeHash`.

**Keep "Save" and "Pin" as two steps.** Auto-pin-on-save makes "I saved an
experiment" indistinguishable from "I changed what every future spawn gets".

---

## 8. Traps in the original framing (explicitly rejected)

- **"Update package versions in the sandbox, then capture."** For *package
  versions* specifically, steer to recipe edits (pinned `pkg@X.Y.Z` in
  `build[]`). Captures freeze native artifacts against today's base image.
  **Capture shines for config tuning, not version management.**
- **"Keep it associated with the given sandbox."** Associate versions with the
  **toolbox**; the sandbox is provenance only — otherwise versions die with
  sandboxes.
- **Auto-pin on save.** Convenient, but collapses two very different decisions
  into one. Reject.

---

## 9. Out of scope (later)

- `paths[]` *extension* on a toolbox (capture user-added paths beyond the
  recipe contract).
- "Diff a capture → suggest a `build[]` edit" affordance.
- Cross-owner promotion (user version → org baseline) beyond the existing
  publish step.
- Automated base-image-drift rebuilds of pinned captures.

---

## 10. Refresh: update a toolbox without a sandbox

Status: **implemented**.

In practice most versions came from the same loop: spawn a sandbox with the
toolbox, run `pi update --all`, save the toolbox, pin it. A refresh runs that
loop on the server (`api/toolbox-refresh.ts`).

- **Update commands**: `refresh: string[]` on the toolbox, e.g.
  `["pi update --all"]`. They run in order as `dev` in a login shell (so
  `~/.local/bin` is on `PATH`) and stop at the first failure. A toolbox
  without update commands cannot be refreshed.
- **Starting point**: the pinned version. When nothing is pinned, the recipe
  build (built if needed and recorded as a `built` version).
- **Where**: a throwaway pod on the toolbox's `source` (default: the sandbox
  base image), with the starting version mounted in the home
  (`RuntimeService.refreshToolset`). No processes run.
- **What is saved**: the toolbox's own `paths[]` (the §2 invariant), through
  the agent's capture route, so the default excludes and the secret scan are
  the same as for a capture from a sandbox. The version's provenance is
  `refreshed`: `from`, `fromVersionId`, `steps`, `trigger`, `by` and
  `sourceImage`.
- **Nothing changed, nothing saved**: the paths are fingerprinted before and
  after the commands, with the pod's own shell tools
  (`runtime/toolset-fingerprint.ts`: type, mode, path, symlink target and
  content, minus the capture excludes; no timestamps, which the artifact
  normalizes anyway). Equal fingerprints: nothing is pushed, no version is
  made, the outcome is `unchanged`. An unknown fingerprint (the hash command
  failed) never skips: the paths are captured.
- **Pin**: automatic. The one exception: when the pin moved while the
  refresh ran (someone pinned or unpinned by hand), that choice is kept and
  the new version is only saved (`pinned: false`). Rolling back is re-pinning
  an older version. This replaces the §7 "Save and Pin as two steps" rule
  for refreshes only: a refresh is the operator's explicit "update what
  every spawn gets".
- **Publish**: the refreshed artifact is always published, since a pin
  reaches every member's sandbox and the publish-before-pin guard requires
  it.
- **Triggers**: Settings → Toolboxes → Refresh in the console,
  `POST /api/toolboxes/:id/refresh` (a `202` job of kind `toolbox-refresh`),
  admin MCP `manage_toolbox` `action=refresh`, and the schedule. One refresh per toolbox at a time: triggering it again
  returns the job already running.
- **Schedule**: `refreshSchedule`, a cron expression (5 fields, or a nickname
  like `@daily`), read in UTC and parsed by `Bun.cron.parse`. At most once an
  hour (checked over the next 24 runs). The toolbox stores `nextRefreshAt`
  (only when it has both a schedule and update commands). A `Bun.cron` tick
  every minute (`index.ts`) starts each due refresh and moves
  `nextRefreshAt` forward before starting it: a failing refresh waits for its
  next slot instead of retrying every minute, and a server that was down
  runs a missed slot once.
- **Outcome**: `lastRefresh` on the toolbox, `{ at, trigger, outcome:
  updated | unchanged | failed, versionId?, pinned?, error?, jobId? }`. It is
  shown in the console and in admin MCP `manage_toolbox` `action=list`
  (`refresh.last`). Nobody is notified elsewhere.

Left out on purpose:

- No smoke test before the pin. A refresh that succeeds can still ship a
  broken tool; re-pin the previous version.
- No refresh for toolboxes without update commands. Their recipe build stays
  cached on its hash: edit `build[]` to pick up new releases.
- No base-image drift handling. A refresh runs on the current base image, but
  native modules the commands do not touch stay as they were captured.
- A recipe edit made while a version is pinned is still ignored; the
  "recipe changed since pin" badge still applies.

---

## 11. Ownership, files and transfer

Status: **implemented**.

- **Org-owned only.** A toolbox belongs to an org (`org_id`). There are no
  user-owned toolboxes: every user has a personal org, and a toolbox you keep
  for yourself lives there. The unique key is `(org_id, slug)`. Any member of
  the org can create and edit its toolboxes. Anyone creating a toolbox picks
  the org with `owner=me` (your personal org, the default) or `owner=org:<id>`.
- **Artifact name.** A toolbox builds to `tb/<toolboxId>`
  (`toolboxArtifactName`), and `create_sandbox` selects one with the selector
  `tb/<toolboxId>`. The caller must belong to the toolbox's org, else 403.
  Version rows created before the migration keep their old
  `tb/<ownerType>/<ownerId>/<slug>` refs, and pinned versions still resolve
  through the stored ref. An unpinned toolbox rebuilds once under the new name.
- **Files.** A toolbox can carry `files`, entries of `{path, content, mode,
  owner}` (content is text or a `$secret` reference) written into every
  sandbox that applies the toolbox. A toolbox with only `files` (no `paths`, no
  build) is valid and builds no toolset. Files merge into the spec before
  enrichment; a file the spec itself declares at the same path wins. This
  replaces the old per-org policy.
- **Org defaults.** The migration turned each org's policy into an
  auto-inject toolbox named `org-defaults` holding the policy's files,
  processes, ports and harness. Policy hooks had no equivalent and were
  dropped.
- **Transfer.** `GET /api/transfers/preview?from=<orgId>&to=<orgId>` and `POST
  /api/transfers {from, to, selection: {secrets, toolboxes}}` move secrets and
  toolboxes between orgs by org id. The caller must own the source org and be a
  member of the target. Moving secrets also needs ownership of the target, so a
  member cannot write secrets into a team org. Admin MCP `manage_toolbox`
  `action=transfer` does the same (`dryRun` previews).
- **Version deletes** take the toolbox id and return 404 for a version of
  another toolbox.
