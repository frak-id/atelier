# v2 Scope Challenge — Alignment Review

**Inputs reviewed:** `docs/proposals/atelier-v2.md` (the proposal) and
`docs/proposals/generic-sandbox-architecture.md` (the design it refines).

---

## 1. Does "composition in the client" reduce total complexity, or relocate it?

**Short verdict: it relocates, not deletes. The runtime is simpler; the total system is not.**

### What the server-side model provided

The generic-sandbox architecture gave the server three capabilities:

1. A **fragment catalog** — a source-of-truth for what "opencode@1.17" or "linear-mcp" means (files, processes, ports, build steps).
2. A **merger** — fold ordered ConfigLayers into a resolved fragment set with defined semantics: additive for processes/ports/files across fragments, last-wins for params/env within a fragment.
3. A **compiler** — expand fragment set + secrets → fully resolved spec, with a `provides/requires` fast-fail check at compile time.

### What v2 actually deletes vs. what it moves

v2 genuinely deletes:
- The catalog as a server-maintained registry
- The `provides/requires` dependency graph
- The typed fragment schema as a server-understood object

v2 does **not** delete the underlying need. It moves it:
- The catalog becomes "presets checked into git" — distributed, unowned, no server enforces shape
- The merger becomes something every client must implement independently to compose a spec from multiple sources
- `provides/requires` disappears; callers get runtime failures instead of spec-time failures

The evidence the merger has not disappeared: v2's §8 open question 1 says "repo-local spec ⊕ user overlay — client-side merged." That merge needs precedence rules, conflict resolution, and handling of additive vs. last-wins fields — the exact merge semantics the server-side merger defined and tested once. Each of {CLI, dashboard, n8n wrapper, CI script} will now re-derive or ignore these rules independently.

### When client-side composition makes sense

The tradeoff favors client-side composition when:
- There are one or two clients (CLI + maybe CI scripts)
- Specs are small and hand-authored
- Organizational policies are thin

It favors server-side composition when:
- Multiple clients exist and must stay consistent
- Presets are shared across teams and need a canonical meaning
- Policy enforcement must be guaranteed regardless of which client a developer uses

v2's bet is that the runtime simplicity unlocks the market position (self-hostable, BYOC-capable), and the client complexity is a workable tradeoff for a small initial client surface. That bet is plausible but only holds if the client count stays small. With the MCP server, dashboard, and CLI all as first-class clients from day one, complexity is already distributed across three surfaces that must independently maintain composition logic.

**Net assessment:** The total system complexity is roughly constant; the runtime complexity drops significantly at the cost of each client carrying more. If you count "the CLI is also part of the system," the runtime simplification is offset by the three-client composition duplication. The v2 proposal should state this tradeoff explicitly rather than claiming a net simplification.

---

## 2. Is "bounded spec enrichment" a merger by another name?

**Short verdict: yes, degenerate case today, will grow merger properties under org pressure.**

The two stated steps are:
- **(a) Secret resolution** — substitute `${secrets.X}` → values. This is genuinely a substitution, not a merge. Well-scoped.
- **(b) Org-policy injection** — append operator-mandated processes/files to every spec crossing the seam.

Step (b) is an append-only, no-conflict-resolution mini-merger today. It becomes a full merger the moment any of these realistic requirements appear:
- A dev spec already defines a process named "audit" → conflict: last-wins? reject? error?
- Org policy says "deny port 8080" (not just "append an entry") → requires set-difference semantics, not append
- Different business units have different policy specs → per-org catalog of policy fragments
- Policy entries themselves reference secrets → nested resolution
- A mandatory env var collides with a user-specified one → collision rule needed

The phrase "no merger, no catalog, no fragment resolution — two append/substitute steps, deterministic, tiny" is accurate for the day-one implementation but underestimates the growth vector. The org-policy surface is where product-level enforcement requirements land, and every surveyed platform with org-level controls (Coder, Gitpod) ended up with a non-trivial policy merge chain at this layer.

**Recommendation:** Acknowledge that org-policy injection is a constrained merger with append-only semantics, define a conflict rule explicitly ("policy entries win, name collisions: policy process renames user process to `user-{name}`"), and build a thin policy-spec schema now rather than growing implicit rules later. This does not require rebuilding the full fragment catalog — it's a two-field schema (`{processes[], files[]}`) on a per-org policy document.

---

## 3. Annotations, saved-specs-as-workspaces, presets-as-snippets — necessary or scope creep?

### Annotations — necessary minimum, keep

Annotations (`atelier.dev/harness: opencode`, `atelier.dev/mcp: linear,github`) are pure metadata: the runtime ignores them, they're optional, they cost nothing to implement. Without them the dashboard renders every sandbox as "a process named acp" with no semantic context. The Fly labels / K8s annotations analogy is correct. Keep.

The key discipline the proposal correctly states: annotations must never change behavior. Enforce this at the schema layer (annotations live outside any field the runtime reads).

### Saved specs as workspaces — necessary, but under-specified

Saved specs are load-bearing: without them, every dev must re-compose their full spec from scratch on every `atelier up`. They are the "workspace" concept renamed, which is fine — but the proposal leaves critical questions unanswered:

- Does a saved spec contain secret **references** (safe to store) or resolved **values** (not safe)?
- If references: the control layer's secret resolution must handle reference formats in stored specs, which means defining the reference syntax (not done anywhere in the proposal).
- Can a saved spec be a **partial spec** (template) that the client fills in, or only a complete SandboxSpec? If partial, you have a server-side template expansion step — which is composition.

These gaps make saved specs an under-scoped surface masquerading as a simple "name → stored JSON" store. Needs a one-page design before phase 2.

### Presets as git-versioned snippets — scope creep for v2 core

The proposal says "shareable presets: a script + metadata that emits spec pieces, client-side, versioned in git." This is a distribution mechanism for client-side composition — useful, but entirely beyond the core value (headless runtime + credential rotation + local-config sync). Nothing in the runtime needs to know presets exist. Defer to v2.5 or later. The CLI can ship with a hardcoded "add vscode" appender without a preset system.

---

## 4. Minimum viable v2

### Core value delivered by v2

1. **Headless runtime**: boot/pause/resume/destroy driven by a fully-resolved SandboxSpec, no harness opinion in the server
2. **Credential rotation**: `PATCH /files`, `PATCH /env`, `hooks.onResume`, and `resume {files, env}` as atomic rotate-on-resume
3. **Local-config sync**: `atelier sync` (`PATCH /files` + local diff walk) + `atelier attach` (WS stdio-bridge)

### Minimum surface for those three

**Runtime API (must-have for core):**
```
POST   /v1/sandboxes                      boot
GET    /v1/sandboxes/:id                  status
POST   /v1/sandboxes/:id/pause
POST   /v1/sandboxes/:id/resume           { files?, env? }
DELETE /v1/sandboxes/:id
PATCH  /v1/sandboxes/:id/files            credential rotation
PATCH  /v1/sandboxes/:id/env              (with envChanged hook semantics)
WS     /v1/sandboxes/:id/attach/:name     stdio-bridge + pty
POST   /v1/sandboxes/:id/exec             one-shot (exists today)
```

**Rust agent extensions (must-have):**
- Phased hooks (`postCreate`, `postStart`, `onResume`)
- Generic N-port forwarder (today one hardcoded pair)
- Unified stdio-bridge / pty attach primitive
- `PATCH /files` endpoint (file push into running sandbox)

**CLI (must-have):**
- `atelier up --spec`, `atelier pause`, `atelier resume --env KEY=val`
- `atelier sync <local-path> <sandbox:path>`
- `atelier attach <id> <process-name>`
- `atelier rm`

### What in the doc is beyond that and should be deferred or cut

| Item | Status | Rationale |
|---|---|---|
| Saved specs / workspace store | Defer to phase 3 | Useful but requires unresolved design questions about reference format; core value doesn't require it |
| Org-policy injection | Defer to phase 3 | Useful but needs explicit conflict rules; core value doesn't need server-side policy |
| `POST /v1/sandboxes/:id/processes` (ad-hoc process add) | Defer to phase 3 | Nice, but `exec` covers most cases; not needed for credential rotation or sync |
| `POST /v1/sandboxes/:id/ports` (expose after boot) | Defer to phase 3 | Not needed for the three core flows |
| `POST /v1/prebuilds` API endpoint | Phase 2, not phase 1 | Prebuild-hash rekeying is important for correctness but doesn't block core value delivery |
| Dashboard rebase | Phase 5 (keep) | Already explicitly deferred, but enforce: no dashboard feature that blocks the CLI path |
| Preset snippet ecosystem | Cut from v2 | Pure distribution mechanism, zero runtime dependency |
| `atelier catalog add` admin verb | Phase 4 (keep) | Critical path — without pre-staged binaries, harness selection regresses to install-at-boot; note this correctly |
| MCP mutation tools | Phase 3 (keep as stated) | Not core but low-cost addition once the API exists |
| Runtime extraction as separate deployable | Explicit non-goal (keep) | Correctly deferred |
| `stdio: "bridge"` single-writer semantics | Must decide before phase 3 API | Product-critical for agent frameworks; "decide at implementation" is not acceptable for a public API |

---

## 5. Under-scoped items — hand-waved as "later" but load-bearing

### 5.1 Repo-spec ⊕ user-overlay merge — not specified, but core to the "per-dev config" goal

The proposal's stated goal is "per-dev content, one substrate." Delivering this via CLI requires every developer to merge a repo-canonical spec (`atelier.jsonc` checked into the repo) with their personal overlay (dotfiles path, preferred harness version, personal secrets). This merge is mentioned in §8 as an open question, but it is the core composition problem relocated from the server.

Minimum required before CLI ships:
- Define the overlay format (separate file? env vars? CLI flags?)
- Define the merge strategy: which fields are additive (processes, files), which are last-wins (resources, env)
- Define where user-local config lives (`~/.atelier/config.jsonc`?)

Without this, `atelier up` can boot a repo's spec but cannot produce "Alice's version of the repo spec with her dotfiles and her GITHUB_TOKEN reference" without Alice maintaining a complete custom spec herself — which kills the "one spec per repo" value proposition.

### 5.2 Secret reference format — completely absent

Specs sent to the API must contain resolved values. Saved specs and repo-checked-in `atelier.jsonc` files must not contain values — they must contain references. The proposal mentions "secret references" and "control resolves them" but never defines the reference format. This is a protocol-level gap that will affect:
- How `atelier.jsonc` is written in repos
- How the control layer recognizes a reference vs. a literal string
- How partial CLI override of a secret (`--env GITHUB_TOKEN=$(gh auth token)`) interacts with stored references

A format like `{ "$secret": "GITHUB_TOKEN" }` or `"${secrets.GITHUB_TOKEN}"` needs to be chosen and documented before phase 1 ships. This is not optional.

### 5.3 Stdio-bridge single-writer policy — deferred but product-critical

The proposal says "single-writer — later attaches are read-only or rejected — decide at implementation." For a runtime marketed to agent frameworks, this decision has significant product consequences:

- **Read-only later attaches** → enables "monitor a running agent session" without interrupting it; correct for most agent use cases
- **Reject later attaches** → simpler but breaks multi-surface observation (CLI + dashboard observing the same session)
- **Multiplexed writes** → complex but needed if the runtime is used for multi-agent coordination

This should be decided at design time, not implementation time. The recommended choice (read-only fan-out, single writer) should be stated explicitly and encoded in the API contract (`WS /attach/:name?mode=observe`).

### 5.4 Catalog ownership and pre-staged binary management — one sentence for a critical-path item

§5's phase 4 says "admin CLI verb (`atelier catalog add opencode@1.17 --sha256 …`) replacing the Helm job." This is a single sentence for a capability that is prerequisite to the entire harness-selection story. Without pre-staged binaries at boot time, any spec that references `/opt/shared/bin/opencode` fails, and the fast-boot model breaks. This needs at minimum:

- A definition of the catalog spec format (how does an admin describe a binary and its pre-stage path?)
- The checksum verification flow (the existing supply-chain TODO mentioned in the proposal)
- A migration path for the existing Helm-managed `sharedBinaries.*` contents

One sentence is not enough design for something blocking phase 4.

---

## 6. Summary findings

### Over-scoped items to cut or defer

1. **Preset snippet ecosystem** — cut from v2; pure client convention, no runtime dependency
2. **Org-policy injection** — defer to phase 3; needs explicit conflict rules not currently defined; start with client-side policy composition as an interim
3. **Saved specs / workspace store** — defer to phase 3 pending resolution of the secret-reference format question; interim: CLI reads `--spec` from file, no server-side storage
4. **Ad-hoc process add / port expose after boot** — defer to phase 3; exec covers the cases that matter for core value
5. **Dashboard rebase** — already deferred to phase 5; enforce the constraint that no client flow is dashboard-only

### Under-scoped items to promote

1. **Repo-spec ⊕ user-overlay merge** — promote from open question to a required design artifact before CLI phase ships; this is the composition mechanism the server-side merger provided
2. **Secret reference format** — promote from implicit assumption to explicit protocol definition before phase 1; affects every spec file in every repo
3. **Stdio-bridge single-writer policy** — promote from "decide at implementation" to a stated API contract in the phase 3 design; recommend read-only fan-out with a single named writer
4. **Catalog ownership and admin verb** — promote from one sentence to a sub-proposal; it is a phase 4 prerequisite that blocks the entire harness selection story

### Verdict on "composition in client"

Client-side composition **relocates** the merger/catalog complexity rather than deleting it. The runtime is genuinely and significantly simpler. Each client is fatter. With three first-class clients (CLI, dashboard, MCP), the total system complexity is approximately constant — the savings are in deployment and operational simplicity (no server-side catalog to keep consistent with client expectations), not in implementation line-count.

The tradeoff is worth it **if**:
- The `provides/requires` fast-fail check is replaced by CLI-side validation (a spec linter that catches "no harness process defined")
- The repo-spec ⊕ user-overlay merge is designed once in the CLI and documented so other clients can replicate the same semantics
- The org-policy injection step is acknowledged as a constrained merger and its conflict rules are defined before adding a second policy entry

### Minimal viable v2 cut

**Phase 1** (seam refactor, behavior-preserving):
- `SandboxSpec` schema in `packages/shared`
- Split `SandboxPorts` into mechanism vs. policy deps
- Rewrite three workflows as: policy-side spec assembly → `runtime.create(spec)`
- Delete `boot-waiter` opencode gate; replace with generic process liveness

**Phase 2** (Rust agent upgrades):
- Phased hooks including `onResume`
- Generic N-port forwarder
- Unified stdio-bridge / pty attach
- `PATCH /files` and `PATCH /env` endpoints with `envChanged` hook

**Phase 3** (runtime API + CLI):
- Expose `/v1/*` routes
- `atelier` CLI: `up`, `pause`, `resume --env`, `sync`, `attach`, `rm`
- Decide and encode stdio-bridge single-writer policy

**Defer to phase 4+**: prebuild hash rekeying, catalog admin verb, saved specs, org-policy injection, dashboard rebase, preset ecosystem.

The proposal as written is well-reasoned and the core thesis is sound. The risks are concentrated in three gaps: the unspecified repo-spec merge, the absent secret-reference format, and the single-writer policy decision. Closing those three gaps before code lands would significantly reduce phase-3 API churn.
