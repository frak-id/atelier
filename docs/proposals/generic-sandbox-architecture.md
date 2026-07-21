# Generic Sandbox Architecture — Fragments + Mechanism/Policy Planes

Status: **superseded by [`atelier-v2.md`](./atelier-v2.md)** — the
mechanism/policy split and substrate/runtime economics carry forward; the
Fragment model and server-side merger/catalog do not (composition moves
client-side; the runtime accepts only a fully-resolved `SandboxSpec`).

Research inputs (in `docs/research/`): `config-modeling-prior-art.md`,
`control-plane-split-prior-art.md`, `fastboot-snapshot-economics.md`.

This note answers a step-back question: the typed **Profile** schema
([`generic-sandbox-profiles.md`](./generic-sandbox-profiles.md)) with fields like
`mcp[]`, `skills[]`, `plugins[]`, `tools[]` feels **too specific** — it will never
enumerate every real need (system `apt`/`npm -g` installs, plugins with many
config files, a harness that ships its own GUI server, a workspace exposing 14
dev servers). It reframes the whole thing around two decisions:

1. **Config model:** stop modeling *features*; model **primitives composed as
   fragments**. (The high-leverage fix — solves "too specific" on its own.)
2. **Mechanism/policy split:** define a **Resolved Sandbox Spec** contract that
   cleanly separates a headless *sandbox runtime* from the *composition/policy*
   layer — as an **internal seam now**, extractable to a separate headless
   service later (not built as two servers up front).

Both are validated by how E2B, Modal, Coder, Gitpod, devcontainers, Fly, Nomad,
and the Firecracker/containerd/k8s stack actually work.

---

## 1. Why the typed Profile schema is the wrong shape

The prior-art survey is unanimous: **no mature platform models "what goes in the
box" as a closed, typed feature list.** They model it as primitives, and the
platform only owns *when* things run, not *what*:

| Platform | Primitive unit | Escape hatch for the un-enumerable |
|---|---|---|
| devcontainers | base image + **Features** + lifecycle hooks | Feature `install.sh` (arbitrary shell); `postCreateCommand` |
| Gitpod/Ona | image + **tasks** + ports | task `command` (shell); tasks are first-class parallel processes |
| Fly Machines | image + `processes[]` + `services[]` | any OCI image; `processes[].entrypoint` |
| Modal | `Image` builder chain | `run_commands("any shell")`, `dockerfile_commands()` |
| Coder | Terraform resources | `startup_script` (shell); any TF resource |
| Nix/devenv | packages + `processes.*` | `shellHook`; `services[].exec` |

The dominant design principle across all of them:

> **The platform owns lifecycle-phase scheduling; the user owns all content
> within each phase.** Composition units contribute to phases **additively** —
> N units each register setup/processes/ports without knowing about each other.

A closed feature schema is an anti-pattern everyone eventually abandons (early
Gitpod fixed images, early E2B template types both grew a shell/Dockerfile escape
hatch that became the primary path). **Design for the escape hatch from day one.**

---

## 2. The core idea: everything is a Fragment

Collapse `harness`, `mcp server`, `skill`, `plugin`, `dev server`, `vscode`,
`browser`, `dotfiles` into **one shape** — a **Fragment** that contributes
primitives. There is no per-feature type; selecting a capability = adding a
fragment, removing it = not adding it.

```ts
interface Fragment {
  id: string;                       // "opencode", "linear-mcp", "vscode", "dev:web"

  // ── substrate primitives: run at PREBUILD, affect the snapshot key ──
  build?: string[];                 // apt/npm -g/compile — baked into the snapshot
  baseImageNeeds?: string[];        // system deps that must exist in the base

  // ── runtime primitives: applied as a cheap overlay at boot, NO prebuild ──
  files?: { path: string; content?: string; source?: string; mode?: string }[];
  hooks?: { phase: "onCreate" | "postStart" | "postAttach"; command: string }[];
  processes?: { name: string; command: string; cwd?: string;
                env?: Record<string,string>; user?: string }[];  // long-lived, supervised
  ports?: { port: number; expose?: boolean; subdomain?: string;
            annotations?: Record<string,string> }[];
  env?: Record<string, string>;

  // ── composition metadata ──
  provides?: string[];              // capabilities, e.g. ["harness"]
  requires?: string[];              // e.g. ["harness"] — merger fails fast if unmet
  params?: Record<string, unknown>; // fragment-specific config (the plugin-needs-config case)
}
```

Everything the old Profile enumerated becomes fragments of this one shape:

- **harness (opencode/claude-code/pi)** → a fragment: `processes` (the ACP/serve
  command), `ports` (a GUI server iff it has one), `provides: ["harness"]`.
  A harness with its own GUI is just a fragment that declares a port — *this is
  the answer to "how to expose a GUI-less harness": it simply contributes no
  port; a GUI harness contributes one. No special-casing.*
- **MCP server** → a fragment: `files` (config written to the harness config
  path) + optional `processes` (stdio server) or `env` (http url).
- **skill** → a fragment: `files` (materialized skill docs).
- **plugin** → a fragment: `files` (config files — solves "plugins need lots of
  config") + `params`.
- **dev server** → a fragment: `processes` + `ports`. 14 dev servers = 14
  fragments; each registers its process + port additively.
- **vscode / browser** → fragments with `processes` + `ports`. Not selected in
  the profile → not present → never boots → zero CPU/mem (the KasmVNC concern).

**Substrate vs runtime falls out for free:** `build[]`/`baseImageNeeds` are the
*only* things that affect the prebuild; everything else is a boot-time overlay.
The research's hard list of "what can't be an overlay" (kernel, system `.so`
loaded at init, runtime version, systemd unit set, CA certs read at import) is
exactly what must live in `build[]` / the base image.

### Harness adapters still exist — as fragment *builders*

An adapter's job shrinks to: given a harness selection + its mcp/skills/plugins,
**emit the fragment(s)** (write config to the right path, produce the launch
process). ACP stays the runtime integration contract; the adapter just knows the
harness-specific file paths/formats — which is exactly what `harness-adapter.ts`
already encapsulates (`configPath`, `mergeProxyProviders`).

---

## 3. The two contracts

### 3.1 Fragment set (composition-plane currency)

Profiles/workspaces/overrides don't contain typed features — they contain
**fragment references + params + inline fragments**. A config *layer* is:

```ts
interface ConfigLayer {                 // global | workspace | dev-profile | session-override
  base?: string;                        // base image
  fragments: (string | Fragment)[];     // "opencode@1.17" | "linear-mcp" | { inline… }
  params?: Record<string, Record<string, unknown>>;  // per-fragment overrides
  env?: Record<string, string>;
  secrets?: string[];                   // references only
}
```

The **merger** (the Profile Merger from the prior note, now merging *fragments*
not typed fields) folds the ordered layers → a resolved fragment set (merge-by-id,
last-wins params). This preserves everything good about the layered-merge design;
it just changes the unit being merged from feature-fields to fragments.

### 3.2 Resolved Sandbox Spec (the mechanism/policy seam)

The **compiler** resolves the fragment set (pull fragment bodies from the
catalog, resolve secret refs to values, split substrate vs runtime) into a
concrete, fully-resolved spec with **no references, no user/org identity, no
merging left to do**:

```ts
interface ResolvedSandboxSpec {
  baseSnapshotRef: string;              // prebuilt snapshot (or base image) — substrate resolved
  resources: { vcpus: number; memoryMb: number; diskMb?: number };
  files: MaterializedFile[];            // concrete content
  hooks: PhasedCommand[];               // onCreate / postStart / postAttach
  processes: SupervisedProcess[];       // name, command, cwd, env, user
  ports: ExposedPort[];
  env: Record<string, string>;          // secrets already resolved to values
  timeoutSeconds?: number;
  metadata?: Record<string, string>;    // opaque pass-through (tracing/billing)
}
```

This is deliberately close to the research's "minimal resolved spec" and to
**today's `SandboxConfig`/`config.json`** — which is already a resolved services
map the Rust agent executes. The gap to close: add `files`, phased `hooks`, and a
`build`/prebuild spec; keep the rest.

---

## 4. The three planes (what handles what)

```
┌─ PLANE 1 · COMPOSITION / POLICY ────────────── "general server" (stateful, opinionated)
│  identity: orgs · users · auth · RBAC · quotas
│  config sources (layers): global default ⊕ workspace ⊕ dev profile ⊕ session override
│  Catalog: fragments (harness/mcp/skill/tool/editor), binaries pre-staged on shared PVC
│  Merger:   fold layers → resolved fragment set (merge-by-id, fail fast on unmet `requires`)
│  Compiler: fragments + secrets → ResolvedSandboxSpec (substrate/runtime split)
│  Dashboard: profile editor + catalog browser (serializations over fragments)
└───────────────────────────────┬───────────────────────────────────────────────
                                 │  ResolvedSandboxSpec  (the seam — internal now)
                                 ▼
┌─ PLANE 2 · SANDBOX RUNTIME / CONTROL ───────── "headless core" (mechanism only)
│  knows NOTHING about orgs/users/profiles/catalog/secrets
│  ops:  prebuild(spec)→snapshot · create/boot(spec) · pause→snapshot · resume · stop · destroy · exposePort
│  substrate: Kata/k3s · TopoLVM CoW snapshots · sshpiper · ingress · image-builder
│  ≈ today's  orchestrators/ + infrastructure/ + sandbox module
└───────────────────────────────┬───────────────────────────────────────────────
                                 │  config.json (services/files/hooks) + agent API
                                 ▼
┌─ PLANE 3 · IN-SANDBOX EXECUTION ────────────── Rust agent (unchanged substrate)
│  runs hooks · supervises processes · exposes ports · ACP bridge · terminal · files · git
│  already agent-agnostic: only reads config.json and runs it
└──────────────────────────────────────────────────────────────────────────────
```

- **Plane 1** is all the "nice to have": who you are, config merging, catalog,
  GUI. Stateful, opinionated, where product features accrete.
- **Plane 2** is the minimal thing a company could run **headless** and drive from
  their own CLI/MCP/tools: "boot/pause/stop/snapshot a sandbox from a resolved
  spec." Fully generic — it accepts *any* spec, so a pi-with-GUI harness, a
  12-MCP agent, or a 14-dev-server workspace are all just specs.
- **Plane 3** already exists and is already generic.

**The seam (ResolvedSandboxSpec) is a typed internal boundary today, a network
API tomorrow.** Build Plane 2 as a module with a clean `runtime.create(spec)`
surface that touches no policy. Extract it into a separate deployable service only
when a real driver appears (BYOC, a second caller, on-prem). Prior art is
emphatic: extract-after-proven beats design-two-servers-first for a small team.

---

## 5. Fast boot with arbitrary config — the rule

From `fastboot-snapshot-economics.md`, the universal model, which this
architecture adopts:

> **Bake the expensive/shared/stable work into a snapshot; apply the cheap/
> per-instance/variable config as a boot overlay. Key the snapshot on the stable
> substrate only — never on user/config — or you get an O(users×configs) matrix.**

Concretely:

- **Prebuild (snapshot) key = hash of the *substrate* fragments only** (base
  image + every fragment's `build[]` + repos). Runtime fragments (processes,
  files, hooks, ports, mcp/skills) **do not** enter the key → one snapshot serves
  every dev profile that shares the substrate. No matrix.
- **Boot overlay** applies runtime fragments: write `files`, run `hooks`, start
  `processes`, register `ports`, inject `env` — all cheap, from the shared PVC.
- **Escape hatch:** a fragment that needs a *baked* system package
  (`baseImageNeeds`/`build[]`) changes the substrate hash → its own prebuild,
  slow once, instant after. Rare, and flagged.
- **Shared read-only catalog** (`/opt/shared`) is the trick that keeps
  harness/mcp/skill/tool selection in the *runtime* tier instead of forcing a
  rebuild — selecting one is spawning a pre-staged binary, not installing.

---

## 6. What already exists vs. the delta

**Already have (evolve, don't rewrite):**
- `BUILTIN_TOOLS` — proto-fragments (`buildServices → services`, ports, exposure).
  Generalize to the full Fragment shape + make them catalog/user-contributed, not
  only builtin.
- `SandboxConfig`/`config.json` — proto-ResolvedSandboxSpec (services map the Rust
  agent runs). Extend with `files` + phased `hooks` + a prebuild spec.
- Rust agent (Plane 3) — already executes a resolved config; add file
  materialization + phased hooks if not present.
- `harness-adapter.ts` — becomes a fragment *builder* (already holds the harness
  config paths/merge).
- `deepMerge` / layered config — becomes the fragment merger.
- Shared-PVC catalog, TopoLVM CoW prebuilds, Kata/ingress/sshpiper — Plane 2 core,
  unchanged.

**The delta (build):**
1. `Fragment` + `ResolvedSandboxSpec` schemas (`packages/shared`).
2. **Merger** (fold layers → fragment set) + **Compiler** (fragment set + secrets
   → resolved spec, substrate/runtime split, fail fast).
3. Generalize the tool registry into the fragment runtime; harness/mcp/skill/dev/
   editor all become fragments.
4. Extend `config.json` + the Rust agent for `files` and phased `hooks`.
5. Prebuild keys on the substrate-fragment hash only.
6. Draw the Plane-1/Plane-2 seam as an internal `runtime.*(spec)` module boundary
   (no policy leakage), so it can later be extracted headless.

---

## 7. Honest risks & discipline

- **Don't build two servers yet.** The seam is a typed function boundary now.
  Standing up a separate headless service before BYOC/second-caller exists is the
  premature-split trap the research warns about (extra hop, proto versioning,
  distributed tracing, for one caller).
- **Fragment model is the high-leverage move; do it first.** It fixes "too
  specific" even if the plane split never happens. Sequence it ahead of the seam
  work.
- **Additive-merge semantics are the subtle part** (as before): fragment sets
  merge by id; `params`/`env` last-wins; `processes`/`files`/`ports` from
  different fragments concatenate (that's how 14 dev servers coexist). Define and
  test once.
- **Escape hatch = arbitrary shell in `build[]`/`hooks`.** That's the point, but
  it means fragments can do anything at build/boot — treat catalog fragments as
  trusted, and sandbox/untrust user-supplied inline shell appropriately.
- **Resist the open-world plugin SDK** (dashboard-managed PVC build jobs, warming,
  verification) until a second harness + a couple of real third-party fragments
  prove the shape. The Fragment *schema* is cheap and high-value now; the *catalog
  management machinery* is later.

---

## 8. Relationship to the other docs

- [`generic-sandbox-profiles.md`](./generic-sandbox-profiles.md): the
  **layering/merge/fast-boot** thinking there is correct and carried forward — but
  the *unit* being layered changes from **typed feature fields** (`mcp[]`,
  `skills[]`, …) to **fragments**. A "dev profile" is just a `ConfigLayer` that
  selects fragments.
- [`acp-multi-agent-dev-profiles.md`](./acp-multi-agent-dev-profiles.md) /
  [`acp-multi-agent-implementation-plan.md`](../plans/acp-multi-agent-implementation-plan.md):
  ACP remains the harness runtime contract; a harness is now delivered as a
  fragment, and the manager's ACP client sits in Plane 1's compiler/dispatch path.

---

## 9. Suggested first step

Land `Fragment` + `ResolvedSandboxSpec` schemas and a pure `compile(layers) →
ResolvedSandboxSpec` (merger + compiler), unit-tested against: additive
process/port/file merge, substrate/runtime split, fail-fast on unmet `requires`.
Then re-express the existing `BUILTIN_TOOLS` (opencode, vscode, browser, terminal,
dev, acp) as fragments feeding it — proving the model reproduces today's behavior
with nothing hardcoded. The plane seam and catalog follow.
