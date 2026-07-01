# Generic Sandbox Profiles

Status: **superseded** — first by
[`generic-sandbox-architecture.md`](./generic-sandbox-architecture.md),
now both by [`atelier-v2.md`](./atelier-v2.md).

> **Reframed:** the layering / merge / substrate-vs-runtime / fast-boot thinking
> below is correct and carried forward. But the *unit* being layered changes from
> the **typed feature fields** in this doc (`mcp[]`, `skills[]`, `plugins[]`,
> `tools[]`) to generic **Fragments** (primitives: files/hooks/processes/ports).
> A closed feature schema is "too specific" and no mature platform uses one. Read
> the architecture note for the current direction; a "dev profile" there is just a
> config layer that *selects fragments*.

Supersedes the "Dev Profiles" framing in
[`acp-multi-agent-dev-profiles.md`](./acp-multi-agent-dev-profiles.md) §6–§8: that
doc treated the dev profile as a *new layer bolted onto* the workspace, and paid
for it with `(workspace × profileHash)` composite prebuild snapshots. This note
reframes the whole thing: **there is one generic `Profile` object**, every
configuration source (global, workspace, developer, GUI experiment) is a
`Partial<Profile>` layer, and a single **Profile Merger** folds them into the
final spec a sandbox boots from. The harness is just one field of the profile.

The goal is to **shrink the hardcoded logic surface**: a sandbox embeds and runs
exactly what its profile selects — nothing more. If you don't put vscode / the
browser / a web UI in your profile, your sandbox doesn't carry them.

---

## 1. The problem: everything is hardcoded and always-on

Two levels of waste today, both because tool selection is compile-time, not
profile-time:

1. **Image bloat (build time).** `infra/images/dev-base/Dockerfile` apt-installs
   KasmVNC + chromium + openbox (the browser/VNC stack) into *every* sandbox
   image, even though only ~1–2 workspaces ever open the browser. (code-server
   and opencode are already better: served from the shared PVC at
   `/opt/shared/bin`, not baked.)
2. **Runtime bloat (boot time).** `orchestrators/tools/registry.ts` iterates the
   full `BUILTIN_TOOLS` list for every sandbox: `buildToolServices()` materializes
   *every* tool's services into `config.json`, and the opencode web-UI surface
   (`opencode serve`, exposed via ingress) is `core: true` for all sandboxes —
   even the ~70–80% that never open it.

The registry is already a **data-driven plugin runtime** — tools are declarations,
not code (`core`/`critical`/`start`/`exposure`/`buildServices`). That part is
done and good. What's missing is a **selector**: which of those tools does *this*
sandbox actually want? Today the answer is hardcoded to "all of them." The
profile is that selector.

---

## 2. Core idea

```
        ┌── global default (platform baseline, mostly empty)
        ├── workspace       (repos + substrate; workspace owner)
Layers ─┤── dev profile     (my harness/tools/skills; portable, per-developer)
        └── GUI override    (ephemeral per-session experiment overlay)
                    │
                    ▼
        ┌───────────────────────────────┐
        │   Profile Merger (pure fn)     │  deep-merge (merge-by-id arrays)
        │   resolveProfile(layers[])     │  → validate → FAIL FAST
        └───────────────────────────────┘  (e.g. no harness = abort spawn)
                    │  ResolvedProfile
                    ▼
        build config.json services + ingress exposures for the SELECTED
        tools only · pick harness · materialize dotfiles/skills/mcp · boot
```

Three principles:

- **One schema, N layers.** Every source is a `Partial<Profile>`. Merge is an
  n-ary fold, not a hardcoded 4-way special case. Adding/removing a layer is a
  list edit.
- **Selected, not embedded.** A sandbox carries a tool iff its profile selects
  it. This applies at *both* levels: runtime (don't start/expose it) and,
  wherever feasible, image (don't bake it — pull from shared PVC or a mountable
  layer).
- **Fail fast.** The merged profile is validated once; missing critical config
  (no harness) aborts the spawn with a clear error, before any pod is created.

### 2.1 The dev-profile layer: user-level, picked at spawn

The **dev profile** layer is a **user-level object, not bound to any workspace**.
A developer owns 0..N profiles ("my Rust setup", "my frontend setup", variants to
A/B) and carries them across every workspace. Selection happens **at spawn**:

- **No profile** → boot from `workspace ⊕ global` only (still fully functional).
- **Exactly one** → auto-pick it, no prompt.
- **Multiple** → the dev picks which one at spawn (open question §9.7: whether
  there's a per-dev default).

The other three layers are owned elsewhere: **global** by the platform,
**workspace** by its owner, **GUI override** is the ephemeral per-session overlay
the dashboard writes for a one-off experiment (never persisted to the profile).

---

## 3. The `Profile` schema

One schema, serialized identically to a file (`profile.toml` in dotfiles),
a dashboard form, and a per-session overlay. Sketch (field names indicative):

```ts
interface Profile {
  // ── substrate: affects the image/snapshot; changing it needs a (re)prebuild ──
  repos?: RepoConfig[];               // git repos to clone (workspace-owned)
  baseImage?: string;                 // base rootfs
  systemPackages?: string[];          // apt packages that must be baked
  initCommands?: string[];            // build-time setup

  // ── harness: the one required-at-spawn field. The ADAPTER materializes its
  //    assets (skills/plugins/mcp) into the harness's own config — generic
  //    sandbox logic never touches harness config formats. ──
  harness?: {
    id: string;                       // "opencode" | "claude-code" | …  (catalog id)
    model?: string;                   // "provider/model"
    skills?: string[];                // catalog ids → adapter installs to the harness skills dir
    plugins?: HarnessPlugin[];        // { id, config? } — NOT bare strings; a plugin may
                                      //   need a config file. Adapter installs them.
    config?: Record<string, unknown>; // escape hatch: raw harness-native config passthrough
  };

  // ── runtime-cheap: process spawn or file write, NO prebuild ──
  tools?: ToolSelection[];            // vscode | browser | <catalog id>; opt-in
  dev?: DevCommand[];                 // one or MORE dev servers (name, command,
                                      //   port, extraPorts, workdir, env, isDefault)
  mcp?: McpServer[];                  // NEUTRAL + top-level: maps to ACP session/new AND
                                      //   adapter dual-delivery (§6.3). Stays top-level so a
                                      //   dev's MCP set survives a harness swap.
  dotfiles?: string;                  // repo to materialize
  env?: Record<string, string>;
  secrets?: string[];                 // REFERENCES to org/workspace secrets, never values
}
```

### Where MCP / skills / plugins live, and who installs them

**Materialization is always the harness adapter's job** — it owns the config
paths/formats (`configPath`, `mergeProxyProviders` on `harness-adapter.ts`).
Generic sandbox logic never writes a harness config file. What differs is *where
the field is declared*:

| Field | Placement | Why |
|---|---|---|
| `mcp` | **neutral, top-level** | ACP standardizes `session/new.mcpServers`; the dashboard renders one uniform MCP list across harnesses; a dev's MCP set should survive swapping the harness. Adapter still does *delivery* (dual: ACP inject + config-file write, §6.3). |
| `skills` | **under `harness`** | No neutral protocol; install path/format is harness-specific. Catalog ids for now (materialized from the shared PVC). |
| `plugins` | **under `harness`** | Harness-specific; **objects `{ id, config? }`, not bare strings** — a plugin may need a config file. `harness.config` is the raw-passthrough escape hatch. |

No *custom merge code* for any of them: the merger is generic merge-by-key
(§4.2). MCP just declares its key is `name`; the machinery is shared.

### The load-bearing distinction: substrate vs runtime

Every field is one of two kinds, and this is what makes fast boot tractable:

| Kind | Examples | Cost to change | Where it applies |
|---|---|---|---|
| **Substrate** | repos, deps, system apt packages, baked binaries | needs a (re)prebuild | image / snapshot |
| **Runtime** | harness selection, mcp, skills, tools, dotfiles, model, env | process spawn / file write | boot overlay |

**Almost everything a *developer* personalizes is runtime-cheap** — *if the
binaries are pre-staged on the shared read-only PVC* (`/opt/shared`, the catalog).
Selecting a harness/tool/MCP then means spawning a pre-staged executable, not
installing anything on the hot path. The only genuinely substrate-affecting
fields are *workspace*-owned (repos, deps), not *developer*-owned.

---

## 4. Merge semantics (the Profile Merger)

`resolveProfile(layers: Partial<Profile>[]): Profile` — pure, unit-testable, no
infra. Reuses the existing `deepMerge` in
`modules/config-file/config-file.service.ts` (already merges global ⊕ project).

Rules to nail down (these are the real design work):

1. **N-ary fold, last wins** for scalars/objects. Order = authority order
   (global → workspace → dev → override).
2. **Arrays merge by id, not concat/replace.** `mcp[]`, `tools[]`, `repos[]`,
   `dev[]` merge on a stable key (`name`/`id`): a dev overriding the `linear` MCP
   replaces *that* entry and keeps the rest; a dev can add a personal dev command
   without dropping the workspace's. Concat would duplicate; replace would clobber.
   This is the single fiddliest rule — define it once, test it hard.
   - **Dev commands are back to a list.** The current schema collapsed the legacy
     multi-command `devCommands` into a single `dev` (`schemas/workspace.ts`); the
     profile restores multiplicity as a first-class `dev[]` array (merge key
     `name`, `isDefault` picks the primary). Runtime kind — no prebuild; a dev
     server is just another selected process the boot overlay starts.
3. **Field authority (start simple).** Begin with pure last-wins. Only if a real
   conflict appears, add per-field locks (workspace can mark `repos`/`secrets`
   non-overridable so a dev profile can't drop a mandated repo). Do **not** build
   the lock system speculatively.
4. **Secrets by reference only.** A profile lists secret *names*; values are
   injected separately from org/workspace scope at boot. A profile must be safe
   to commit to a public dotfiles repo.
5. **Validate → fail fast.** `.parse` the merged result against the full schema.
   Missing `harness` (or any critical field) throws *before* pod creation, with a
   message naming the missing piece and which layer could supply it.

---

## 5. Boot & prebuild: no fat matrix

The proposal's `(workspace × profileHash)` composite snapshots are **not** the
default here — that's the "fat AF matrix" and it's avoidable.

```
prebuild key = workspace          (repos + deps only — substrate, workspace-owned)
         ▼
one workspace snapshot  ──serves──▶  every developer's profile
         +
runtime profile overlay at boot   (spawn selected harness/tools, write mcp/skills/
                                    dotfiles from the shared PVC — cheap, no prebuild)
```

- **Common case (90%):** one snapshot per workspace. Each dev overlays their
  runtime profile on top at boot. No per-dev snapshot, no matrix.
- **Escape hatch (rare):** a profile whose *substrate* differs (needs a system
  apt package baked) triggers a per-profile prebuild — slow once, instant after.
  This is the exception, flagged in the UI, not the rule.
- **Browser/VNC (the KasmVNC point) — decided: keep it baked, gate at runtime.**
  The browser/VNC stack stays in the base-features image (no relocation work).
  The waste we actually care about is CPU/memory, and that's a *runtime* cost: if
  the profile doesn't select the `browser` tool, its services are never
  materialized into `config.json` and never started — **never boots, never
  consumes resources.** Image *size* de-bloat (shared-PVC relocation / base
  features) is a possible later optimization, not needed for the resource win.

---

## 6. What already exists vs. the delta

**Already have (keep):**
- Data-driven tool plugin runtime — `BUILTIN_TOOLS` with `buildServices`,
  `core`/`critical`/`start`/`exposure`. This *is* the plugin runtime.
- Deep-merge for layered config — `deepMerge` / `getMergedForSandbox`.
- Shared-PVC catalog mechanism for binaries (`/opt/shared/bin`).
- Harness adapter seam (`shared/agent/harness-adapter.ts`), single concrete today.

**The delta (build):**
1. `Profile` schema (`packages/shared`) — one type, substrate/runtime split.
2. `resolveProfile()` merger — n-ary fold, merge-by-id arrays, fail-fast validate.
3. **Profile-driven tool selection** in `registry.ts`: iterate the tools the
   *resolved profile* selected, not all of `BUILTIN_TOOLS`. `buildToolServices`,
   `bootServiceNames`, `coreServiceNames`, exposures all key off the selection.
   Drop opencode's hardcoded `core: true`; the harness/web-UI is whatever the
   profile picks.
4. Prebuild keying stays `workspace`; add the runtime overlay step at boot; add
   the substrate escape hatch for the rare substrate-diff profile.
5. Runtime gating of baked tools (browser/VNC): don't materialize/start what the
   profile didn't select (§5). Image *size* de-bloat is an optional later step.
6. File-driven profile + dashboard profile editor — both serializations of the
   same object, replacing the scattered per-tool UI.

---

## 7. Non-goals / discipline

- **Not** an open-world plugin SDK yet. The tool runtime is generic *enough*;
  don't build dashboard-managed PVC jobs, warming states, and MCP verification
  until a second harness and a couple of real optional tools prove the shape.
  Same discipline the harness adapter already applies ("a single concrete adapter
  avoids dead multi-harness scaffolding").
- **Not** dropping `opencode serve`. It stays as opencode's rich session surface
  (hierarchy/questions), now selected by profile instead of hardcoded — see
  [`acp-multi-agent-implementation-plan.md`](../plans/acp-multi-agent-implementation-plan.md) §4c.
- **Not** putting secrets in profiles — references only (§4.4).

---

## 8. Suggested first step

Land the **schema + merger in isolation** (`Profile`, `resolveProfile`), fully
unit-tested against the array-merge and fail-fast rules — no infra, no boot
changes. Then wire the merger's output into `registry.ts` so tool *selection*
becomes profile-driven (the first visible win: a sandbox without vscode/browser
in its profile stops materializing them). Image de-bloat and the dashboard editor
follow.

---

## 9. Decisions & remaining questions

Resolved:

1. **Layer count — ship all four** (global → workspace → dev → GUI override). The
   merger is n-ary regardless.
2. **Dev profiles are user-level objects** (§2.1). Not bound to a workspace; a dev
   has 0..N; picked at spawn.
3. **Field authority — pure last-wins first.** No per-field locks until a real
   conflict forces one.
4. **Browser/VNC — stays baked, gated at runtime** (§5). No relocation work.

Still open:

5. **Array-merge key per collection.** Confirm each: `name` (mcp, dev), `id`/`slug`
   (tools, plugins), `clonePath` (repos).
6. **Plugin config shape.** Is `{ id, config? }` + a `harness.config` passthrough
   enough, or do some plugins need file materialization beyond a config blob?
7. **Default profile selection.** When a dev has multiple profiles, is there a
   per-dev default, or always an explicit pick at spawn?
