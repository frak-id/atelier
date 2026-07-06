# Atelier Console — UI Evolution

> Follow-up to the v2 redesign (`IMPLEMENTATION_PLAN.md`). Captures the next
> wave of changes decided with the user + two oracle consultations
> (`opus-4-8` for the harness web UI, `claude-fable-5` for the template/UX
> reframe). Raw oracle notes: `apps/console/design/oracle-ui-evolution.md`.
>
> **Guiding principle — modularity:** the org's *database* (harnesses,
> toolboxes, prebuilds, saved specs), not the console's *source code*, decides
> what a company can spawn. Static data may **seed**, never **serve**. A
> claude-code-first or pi-first company must see *their* stack reflected
> everywhere without a console change.

Scope of this doc:
1. Fixes (regressions found in review/QA)
2. Template system redesign (the "template gallery" reframe)
3. Harness modularity + per-harness web UI
4. Lazy / not-running services — URL list + ImmersiveView
5. Consolidated schema/server changes
6. Smallest-coherent-v1 checklist + flagged gaps

---

## 1. Fixes

- **[DONE] Index crash `t.createdAt.localeCompare is not a function`.**
  `routes/index.tsx` `SandboxesSection` sorted with a bare
  `b.createdAt.localeCompare(a.createdAt)`. `createdAt` is `Type.String()` /
  `text` server-side, but at least one staging row returns a non-string, so
  the bare call throws and blanks the whole index. The review pass had removed
  the old `String(… ?? "")` guard as "defensive over-engineering" — it was
  load-bearing. Restored a coerced sort:
  `String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))`.
  *(Root-cause TODO: confirm whether the deployed staging server emits a
  non-string `createdAt`; if so, fix at the source too.)*

---

## 2. Template system redesign

**Problem (user):** the surfaced static `TemplateGallery` (9 hardcoded
templates: opencode/vscode/pi/ask-a-codebase/…) breaks modularity. Offering
"just OpenCode / Ask-a-Codebase" without the org's own toolboxes/harnesses is
nonsense; a company standardizing on claude-code/pi must see that. The user
also initially expected "template gallery" to be a Settings config-helper, not
a spawn catalog.

**Decision:** a "sandbox template" **is a saved spec promoted to the gallery** —
not a new entity, not static data. Static catalog is **demoted to seed
examples** an admin imports/forks into real, org-owned saved specs.

### 2.1 Data model — extend `saved_specs`, don't duplicate

`saved_specs` today: `{ id, orgId?, name, spec, policyRefs, createdAt }`. Add:

```ts
template: boolean            // "published to the gallery" (default false)
meta: TemplateMeta | null    // presentation only
// TemplateMeta = { description?: string; icon?: string; params?: TemplateParam[] }
// TemplateParam = { key: string; label: string; kind: "repo-url" | "string";
//                   required?: boolean; hint?: string }
```

One entity → one CRUD, one scoping model (org/user already works), one
policy/enrichment path. A separate `templates` table would duplicate scoping,
listing, permissions and the spec column, then drift.

- (+) Smallest delta: 2 nullable columns; existing saved-specs routes just
  accept/return the new fields.
- (−) `meta.params` is presentation-adjacent logic in a JSON blob; accept it —
  start with exactly one param kind and keep the runtime spec contract
  untouched.

### 2.2 Parameterized templates — "Ask a Codebase" done right

The template's `spec` is stored **complete**, including the correct
`toolboxes` selectors — the admin bakes the right toolbox in, so a
booted sandbox always carries it (fixes the user's "must come with the proper
toolbox" complaint; the console never guesses).

Parameters are **fill-in-the-blank at spawn**, applied by **typed,
harness-agnostic transforms** — *param kinds are code, values are data* (no
`{{var}}` string interpolation into spec JSON — that's a shell/JSON/injection
footgun):

- `meta.params: [{ key: "repoUrl", kind: "repo-url", required: true }]`
- Spawn card renders an input per param; on spawn, the `repo-url` kind runs the
  existing **`withRepoClone`** logic (validate + shell-quote → append
  `git clone` to `hooks.postCreate`), now keyed behind the param kind.

### 2.3 Seed catalog (why not delete it outright)

Cold start: a fresh org has zero saved specs — pure "render from DB" leaves the
Operator lens empty and the Builder lens a bare JSONC editor. So keep a small
curated catalog **only as Builder-visible seeds**: "Start from an example →
creates a saved spec you own," clearly labeled as examples. Once imported it's
a normal saved spec (org-owned, editable, reflecting whatever harness/toolbox
the org swapped in). The current `src/lib/templates.ts` array shrinks to this
seed data; `templateToRequest()` becomes the import transform.

### 2.4 Lens behavior

- **Operator:** the gallery only — **all published org templates** (`template:
  true`) as one-tap cards (with param inputs where declared). No prebuild list,
  no editor, no raw saved specs.
- **Builder:** gallery + QuickSpawn-from-prebuild + all saved specs + JSONC
  editor (i.e. "same as before" + one-tap gallery on top).
- **Delete `OPERATOR_DEFAULT_IDS`** once import-seeding lands — which templates
  an operator sees is an org curation decision (`template: true`), not a
  hardcoded ID list. (Persona fields already removed in review — keep it.)

### 2.5 Pushbacks (from the oracle, worth honoring)

- **"Gallery = Settings config helper" undersells it.** The gallery is the
  Operator *consumption* surface and must stay on spawn. What moves to Settings
  is template *authoring/publishing* (§5/D below).
- **Don't make prebuild-QuickSpawn an Operator surface.** A prebuild is an
  infra optimization (a snapshot), not a product-shaped thing. If an org wants
  a prebuild-backed template, the saved spec's `source.snapshot` points at it —
  same gallery card, faster boot, invisible to the operator.

---

## 3. Harness modularity + per-harness web UI

### 3.1 Harness set is data, never hardcoded

Derive available harnesses at runtime from two sources that already exist:

1. **Registered composers** — `listHarnesses()` in `@atelier/compose` (server
   registers opencode + pi at bootstrap). Expose via a tiny
   **`GET /api/capabilities → { harnesses: ["opencode","pi", …] }`** (or fold
   into the existing public-config route).
2. **Toolboxes that declare a harness** — `toolbox-config-spec.ts` already has
   the optional `harness` field; a declared harness not in the composer
   registry is a *misconfiguration to surface*, not hide.

The UI renders harness as data: template cards show the badge from the spec's
`atelier.dev/harness` annotation; the "new template/spec" authoring flow offers
a harness picker populated from `/api/capabilities`.

**Gap to flag:** there is **no capabilities endpoint today**; the only
"opencode-or-pi" worldview lives in the static catalog (which §2 deletes).

### 3.2 How to add a harness (e.g. claude-code) — the modularity story

1. A `HarnessComposer` in `@atelier/compose` (`composeClaudeCode()`): its acp/
   bridge process, config files, `atelier.dev/harness` annotation.
2. Server bootstrap: `registerHarnessDispatch` + `sessionSurfaces.register`.
   *If the harness speaks ACP*, reuse the generic ACP-over-attach surface (the
   pi work just proved this). *A non-ACP harness needs its own session surface
   implementation* — a bigger lift; flag it.
3. A toolbox recipe that installs the binary (the staging pi recipe in
   `design/templates.md` is the template).
4. **Nothing in the console** — it discovers the id via `/api/capabilities` +
   annotations.

### 3.3 Per-harness web UI ("Open" → harness's own UI, iframe)

Decided with the user; user confirmed on staging that **`opencode serve` runs
auth-less (no `OPENCODE_SERVER_PASSWORD`)** and **coexists safely with the
primary `opencode acp`** sharing `~/.local/share/opencode`.

**Design (smallest correct):**
- Add a **lazy** `serve` process to `composeOpencode` (started only on demand):
  `opencode serve --hostname 0.0.0.0 --port 4096 --cors https://<console-baseDomain>`,
  `user: dev`, `lazy: true`, `readiness: { port: 4096 }`.
- Add `ports: [{ name: "opencode", port: 4096, public: true, auth: "forward" }]`.
  This auto-emits `opencode-{id}.{baseDomain}` into `sandbox.urls` — no new
  runtime plumbing.
- **Auth: none needed.** Rely entirely on the existing oauth2-proxy
  forward-auth at the ingress. The console user already holds the
  `*.baseDomain`-scoped session cookie — **proven by the working vscode/browser
  iframe tabs** — so the harness UI on the same cookie domain inherits it. An
  iframe can't inject an `Authorization` header, so the v1 Basic-Auth model was
  a non-starter anyway; auth-less-behind-forward-auth is the clean path.
- **No secret, no schema change** for exposure. `SandboxUrlSchema`/`PortSchema`
  are sufficient.

**Which URL is "the harness UI" (console picks the Open target):** convention —
name the port after the harness id (`opencode`/`pi`), which flows into
`sandbox.urls[].name`. Console: `urls.find(u => u.name === harnessFromAnnotations(sandbox))`,
fall back to the terminal tab. Pure console change. (If richer intent is ever
needed — icon, ordering, multiple UIs — use an annotation
`atelier.dev/harness-url`, never widen `SandboxUrlSchema` for a *display* hint.)

**Coexistence risk mitigation:** `serve` is **lazy** — normally there's exactly
one opencode (`acp`); the shared-state question only arises when a user clicks
"Open → harness UI". Validate under that narrow condition. If two-writers ever
proves unsafe, escalate to the bigger "pivot the harness to `serve` and drive
sessions over it" project (what v1 did) — but don't block this feature on it.

**pi:** self-host pi's in-sandbox web server the same way
(`{name:"pi", port, public:true, auth:"forward"}` on `pi-{id}.{baseDomain}`).
**Reject external `pi-web.dev`:** a third-party origin won't carry the
`*.baseDomain` oauth2-proxy cookie (every request 302s to the IdP),
forward-auth's 302 breaks cross-origin XHR, and it would force CORS-allowing a
SaaS origin *with credentials* — coupling our security to a third party.

**Gating process:** the harness-UI port's gating process is the lazy `serve`
process (via its `readiness:{port:4096}`), so "Open → harness UI" gets the
start-then-load flow from §4 for free.

---

## 4. Lazy / not-running services — URL list + ImmersiveView

**Problem (user):** clicking an ImmersiveView tab for a lazy process that isn't
booted (vscode; or browser when kasmvnc/openbox/chromium aren't up) lands on a
blank **Bad Gateway**. And the sandbox URL list shows every URL regardless of
whether its service is running.

**Core difficulty:** `url.name` (the *port* name) ≠ the gating *process* name in
general — the `browser` port is served by the `kasmvnc` process (+ openbox +
chromium); only `vscode` happens to match 1:1.

**Decision: server resolves port→gating process; expose live readiness on the
state — do NOT solve with a console heuristic.** The info already exists: a
process's `readiness:{port}` declares which port it gates.

### 4.1 Schema (the one justified change)

Widen `SandboxUrlSchema` with two **optional** fields (additive, no consumer
breaks):

```ts
{ name, url, processes?: string[], ready?: boolean }
```

- `processes`: **all** processes that gate this URL — a URL can depend on more
  than one (e.g. the `browser` port needs `kasmvnc` + `openbox` + `chromium`).
  Resolve as every process whose `readiness.port === port.port`, plus (fallback)
  a process whose name equals the port name; empty/undefined if none.
- `ready`: `true` only when **all** `processes` are live-ready
  (`ready ?? running`), from the **same `processStatuses()` union the state
  endpoint already computes** — zero new agent round-trips.

Why schema (not annotation): readiness is *live runtime state*, not a static
display hint. `urlsFor()` currently builds from spec only; the state endpoint
already has both spec + live process status, so this is plumbing, not
architecture.

### 4.2 Console — one shared `useServiceGate(url)` hook

- **ImmersiveView tab** where `url.processes` is non-empty and `!url.ready`:
  render a panel *instead of* the iframe — service name(s) + **Start** button →
  start **each** not-yet-running process
  (`useProcessAction(sandboxId).mutate({ name, action: "start" })` per process) →
  poll sandbox detail (query already refetches; ~1–2s while starting) until
  `url.ready` → **wait ~500 ms grace** (ingress/endpoint propagation lags the
  readiness probe) → mount the iframe. Spinner in the panel during start. If
  `url.processes` is empty/undefined → keep today's optimistic iframe (graceful
  degradation).
- **URL list (sandbox detail):** partition by `ready`. Running URLs are links;
  not-running ones are **grayed rows** with an inline "service not running —
  Start" (same mutation). Never hide them — discoverability of lazy tools is
  the point of the declared-process union.

---

## 5. Consolidated schema / server changes

| Change | Kind | Notes |
|---|---|---|
| `saved_specs.template: boolean` + `saved_specs.meta: json` | schema + routes | §2.1; existing saved-specs routes accept/return |
| `GET /api/capabilities → { harnesses }` | new read-only endpoint | §3.1; from `listHarnesses()` |
| `composeOpencode` lazy `serve` process + `opencode` forward-auth port | compose | §3.3; mirror for pi |
| `SandboxUrlSchema` += optional `{ processes: string[], ready }`, populated in state endpoint | schema + runtime | §4.1; resolve port→processes via `readiness.port` (multiple allowed), reuse `processStatuses()` |

Everything else is **pure console work**. Notably, **exposure needs no schema
change** (ports/urls/forward-auth are already generic) and the **harness web UI
needs no secret**.

Console work: gallery reads published saved specs + param inputs; seed-import
flow; Settings → Templates route + shared "save/publish as template" dialog;
lens layout on spawn; `useServiceGate` (readiness-gated iframes + grayed URL
rows); harness badges/pickers from capabilities + annotations; "Open → harness
UI" target selection.

---

## 6. Smallest coherent v1

1. **Server (small):** `saved_specs` `template`+`meta` columns (+ routes);
   `GET /api/capabilities`; `SandboxUrl` optional `{processes, ready}` populated
   in the state endpoint; `composeOpencode` lazy `serve` + forward-auth port.
2. **Console:**
   - Gallery = published templates from `savedSpecsListQuery` (+ param inputs);
     static catalog → Builder-only "import example → saved spec" seeds; delete
     `OPERATOR_DEFAULT_IDS`.
   - Spawn lens layout: Operator = gallery; Builder = gallery + prebuilds +
     saved specs + editor.
   - Settings → Templates route + one shared "save/publish as template" dialog
     (reachable from the editor, a saved-spec row, **and a running sandbox's
     detail page** — "save this sandbox's spec as a template", the
     highest-leverage entry point).
   - `useServiceGate`: readiness-gated iframes in ImmersiveView + grayed
     not-running URLs with inline Start.
   - "Open" prefers the harness-UI url (by convention) → start-then-load →
     iframe; falls back to terminal.
   - Harness badges/pickers driven by `/api/capabilities` + annotations.

### Settings vs spawn (D)

- **Settings → Templates** (beside toolboxes/toolsets/prebuilds): list org/user
  saved specs with `template` flag; create/edit (name, description, icon,
  params, harness via capabilities picker, spec via editor or "fork from
  example seed"); publish/unpublish toggle; org-vs-personal scoping reuses the
  existing owner model; "import example" lives here.
- **"Save as template"** = one shared dialog, reachable from the editor, a
  saved-spec row, and a running sandbox detail page — all write through the one
  saved-specs API (mitigates entry-point divergence).

---

## 7. Flagged gaps / future (NOT v1)

- **claude-code (or any new) harness:** the 4-step recipe in §3.2. Non-ACP
  harnesses additionally need a bespoke session surface (bigger lift).
- **Richer param kinds:** enums, secret-backed params → will want real
  validation beyond the JSON blob.
- **Template versioning / audit:** who published what, when; rollback.
- **Harness web UI hardening:** confirm `opencode serve` still ships the browser
  GUI on `dev-base-v2`; validate serve+acp coexistence under real session load;
  the `--cors` origin must equal the console base domain.
- **ImmersiveView focus trap** (carried from redesign review) — a11y.
- **Fleet per-sandbox query errors swallowed** (carried) — surface per-sandbox
  error state; pairs with the future `GET /sessions/all` aggregate.
