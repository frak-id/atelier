# Atelier Console — UX & Look-and-Feel Audit

> **Scope:** `apps/console` (the v2 GUI over `@atelier/server`).
> **Goal:** Take the console from "functional operator panel" to a product that
> feels premium and effortless for **two audiences at once** — developers who
> want power and density, and product/C-level users who want to rapidly reach a
> preconfigured agent on a codebase without touching infrastructure.
> **Method:** Full read of the current implementation + competitive UX research
> (Vercel, Cursor, Devin, Replit, Copilot Workspace, Gitpod, Coder, Warp,
> Linear, Railway, Stripe, Superhuman) + agent-UX and dual-audience research.
> Sources are listed at the end.

---

## TL;DR

The console is **feature-complete and technically clean**, but it presents like
an internal admin tool: a light-mode stack of shadcn cards, uniform weight,
no hierarchy, no agent-work narrative, no onboarding, and a hard split between
"management chrome" and the "actual work." It does not yet feel like a product
you'd demo to a CTO, and it makes a developer do more clicking than a
keyboard-first tool should.

The five highest-leverage moves:

1. **Reframe the home page as a "mission control" for agents**, not a list of
   sandboxes. Lead with *what the agent is doing and whether it needs you*.
2. **Introduce two lenses over one data model** — an **Operator** view (simple,
   status-first, safe) and a **Builder** view (dense, terminal-first,
   keyboard-driven) — via progressive disclosure, not two apps.
3. **Fix the visual foundation**: commit to a real (dark-first) theme with a
   distinctive identity, fix the light-app/dark-terminal clash, add the missing
   micro-states, and replace the default shadcn look.
4. **Add a first-class agent session experience** (chat + structured progress +
   plan/permissions inline), instead of the current todos/permissions/questions
   scattered across cards.
5. **Engineer the empty states & onboarding** — the first action should be a
   *selection* ("pick a repo, pick an agent, go"), not a blank JSONC editor.

---

## 1. What Exists Today (current-state map)

| Surface | Route | What it does | UX verdict |
|---|---|---|---|
| Sandbox fleet | `/` (`index.tsx`) | Sorted list of sandbox rows: id, status badge, harness, relative time, pause/resume/destroy | Functional, flat. No grouping, no agent context, no "needs attention". |
| Sandbox detail | `/sandboxes/$id` | URLs, embedded terminal, processes, expose-port, capture-toolset, metadata, immersive mode | Everything is a same-weight card stack; the important thing (the running agent) is buried under infra forms. |
| Sessions | `/sandboxes/$id/sessions` | Live ACP sessions grouped by directory, todos, permission & question prompts | The real product is here but hidden two clicks deep; no chat/transcript, todos in a side box. |
| Spawn | `/spawn` | Quick-spawn from prebuild, saved specs, raw JSONC editor | Powerful for devs, opaque for everyone else. Raw JSONC as a primary surface. |
| Settings | `/settings/*` | api-keys, ssh-keys, secrets, orgs, policy, toolboxes, prebuilds | Reasonable operator console; tab bar is undifferentiated. |
| Auth | `login-page.tsx` | GitHub OAuth single card | Clean but generic; no product story. |

**Stack (good foundations):** React 19, TanStack Router/Query, Tailwind v4,
shadcn/Radix, xterm, Eden Treaty typed end-to-end. Nothing here needs to be
thrown away — this is a re-skin + re-architecture of *hierarchy and flow*, not a
rewrite.

---

## 2. The Core Problems

### 2.1 Identity: it looks like a default shadcn install
`index.css` is the stock shadcn HSL token set (`240` neutral, `--radius: 0.5rem`)
and the UI reads exactly like that. Per premium-UI research, an *unmodified*
shadcn install "looks like every other unmodified shadcn install" — the premium
signal is in the *customization*, microstates, and typography, none of which are
present yet. There is no brand anchor (typeface, accent, dark identity) that
would make an executive pattern-match to "mature, trustworthy tool."

### 2.2 The app is stuck in light mode, but the terminal is dark
`index.css` defines full `.dark` tokens, but **nothing ever applies the `.dark`
class** (confirmed: no theme provider, no toggle). Meanwhile `terminal-view.tsx`
hardcodes a dark `THEME` and `multi-terminal.tsx` hardcodes `bg-[#09090b]`. The
result is a **light chrome wrapping a black terminal** — the single most jarring
visual clash in the product, and the terminals are the hero surface for
developers. Dev tools in this category (Linear, Vercel, Cursor, Warp, Railway)
are dark-first.

### 2.3 No hierarchy — everything is a card of equal weight
Every page is `Card` → `CardHeader` → `CardContent`, stacked vertically at
`max-w-5xl`. "Expose port," "Capture toolset," and "the live agent terminal" get
identical visual priority. There is no composition that "leads the eye" to the
primary action on any screen — the #1 thing premium UIs do.

### 2.4 The agent — the actual product — is buried and under-told
Atelier's reason to exist is *a coding agent working on a codebase*. Yet:
- The home page never mentions the agent, its task, or its status.
- Agent work lives at `/sandboxes/$id/sessions`, two clicks in.
- There is **no conversation/transcript view** — only todos, permission
  prompts, and questions rendered as separate cards. You cannot see *what the
  agent is doing or has done* as a narrative.
- There is **no plan-before-execute**, no structured progress timeline, no
  run summary. Competitors (Devin, Copilot Workspace, Replit) make this the
  centerpiece.

### 2.5 One audience served, one ignored
The current UI is squarely a **developer/operator** tool: JSONC editors, raw
`ref` strings, `vcpus`/`memoryMb` inputs, path-set capture. A product/C-level
user has **no on-ramp**: no templates, no plain-language status, no "just run an
agent on this repo" path, no safety framing. The brief explicitly names this
second audience; today they'd be lost on the `/spawn` page.

### 2.6 Empty states are dead ends (and stale)
The home empty state says *"Spawn your first sandbox — spawning lands in the next
milestone."* — stale copy pointing nowhere. Spawn's primary editor is an empty
JSONC textarea. Best practice: the first interaction should be a **selection**
(pick a repo / pick a template / pick an agent), not authorship from a blank
canvas.

### 2.7 Missing power-user affordances
No command palette (`⌘K`), no global keyboard shortcuts (only `Esc` in immersive
mode), no quick sandbox switcher, no search. For the developer audience this is
table stakes (Linear, Vercel, Cursor, Superhuman all lead with it).

### 2.8 Micro-states & polish gaps
- Buttons/inputs use default focus/hover; no designed focus rings or pressed
  states (premium UIs design all six states).
- Loading is generic `Skeleton` blocks and spinners rather than layout-matched.
- No motion system — status changes, card entry, blocked-state attention all
  pop in with no transition.
- Raw checkboxes (`<input type="checkbox" className="size-4">`) sit next to
  Radix components — inconsistent.
- Navigation has no active-scope context (org switcher lives only in settings).

---

## 3. What "Great" Looks Like (research-grounded targets)

Distilled from the competitive/UX research (full brief in the appendix):

**A. Mission-control home (Devin / Cursor Agents Window / Replit Task Board).**
The landing surface is *all agent work at a glance*, organized by what needs the
human: a **Kanban or grouped list** with states `Spawning → Running → Needs
input → Ready for review → Done`. "Needs input" floats to the top and pulses
gently. Non-technical users read Kanban natively; developers get a mission map.

**B. Two lenses, one data model (Stripe / Notion / Retool / Coder).**
Same URLs, same data, two renderings. **Operator** mode: phase labels in plain
English, time/cost estimate, one primary action, decisions not diffs.
**Builder** mode: terminal, logs, config, diffs, token counts, `⌘K`. It's a
*display preference*, persisted, toggled freely — never a separate app, never a
gate. Progressive disclosure hides **complexity, never consequences** (destructive
actions stay visible with friction in both modes).

**C. Agent narrative as the centerpiece (Devin Progress tab / Copilot plan).**
A session = a **chat/transcript + a structured progress timeline** (named steps,
status icons) + inline plan + inline permission/question prompts. Developers can
drop to raw terminal; operators stay in the readable Progress view. Every run
ends with a one-sentence **"what happened"** summary and a decision frame
(Approve / Request changes / Discard).

**D. Trust & safety made visible (agent-UX research).**
- **Plan-before-execute**: show intended steps, let the user edit, then run.
- **Autonomy dial** per run: Supervised / Balanced / Autonomous.
- **Plain-language permission prompts**: *what / why / risk / decision*, not a
  bare `permission` string with glob patterns.
- **Isolation semantics**: "your main branch is never touched until you approve."
- **Cost/time estimate** before launch; immutable per-run audit record after.

**E. Premium visual foundation (Linear / Vercel / Railway / Stripe).**
- Dark-first, distinctive (Railway's deep indigo-midnight is a good north star —
  "not just black"), with a real light theme too.
- One typeface family + one mono, systemic scale; a single restrained accent
  used for *meaning* (running/needs-input/error/review), not decoration.
- Designed microstates, hairline borders at low alpha, layout-matched loading,
  a defined motion vocabulary (150–200ms), instant navigation.

**F. Empty-state engineering & onboarding (Vercel / Gitpod / Val Town).**
First run = a guided *selection* flow (repo → agent → task → preview → go), a
template gallery for operators, and an "Open in Atelier" deeplink/badge for
repos. A read-only demo run lets execs watch the lifecycle before authorizing
anything real.

**G. Keyboard-first escape hatch (Linear / Superhuman / Cursor).**
Global `⌘K` palette: spawn, switch sandbox, open terminal, jump to session, add
secret, search. Invisible to operators, indispensable to developers.

**H. Block-based / navigable terminal (Warp).**
Treat agent tool-calls as navigable blocks (jump to the failed step, copy,
bookmark) rather than an undifferentiated scrollback — turns the terminal from a
log sink into an audit trail both audiences can use.

---

## 4. Recommendations (prioritized)

### P0 — Foundation & identity (fast, high impact)
1. **Ship a real theme system.** Add a theme provider, default to **dark**,
   allow light + system. Replace the stock shadcn tokens with a distinctive
   palette (deep indigo-midnight base à la Railway; single violet/brand accent;
   semantic green/amber/red/blue for status). Unify the terminal theme with the
   app tokens so there's no light/dark clash.
2. **Commit to a type system.** One UI family (Inter / Geist / IBM Plex Sans)
   + one mono (JetBrains/IBM Plex Mono), 4–6 sizes, tabular numbers for IDs and
   metrics, optional serif for the wordmark only. This alone moves perceived
   quality a tier.
3. **Design the six microstates + focus rings + a motion vocabulary** in the
   `ui/` primitives. Replace raw `<input type=checkbox>` with the Radix checkbox
   everywhere.
4. **Rewrite empty states** (kill the stale "next milestone" copy) into
   actionable, selection-first CTAs with a real onboarding path.

### P1 — Information architecture & the agent
5. **Redesign `/` as mission control.** Group/kanban by state, surface
   "needs input" first, put agent + task + repo + elapsed on each card, add
   status chips with consistent color semantics. Offer a card ↔ table density
   toggle for power users.
6. **Add a real session/agent surface**: transcript + structured progress
   timeline + inline plan + inline permission/question prompts, with a
   Progress ↔ Terminal ↔ Logs tab model. Promote it from a sub-route to a
   primary destination.
7. **Introduce Operator vs Builder lenses** with a persisted toggle and
   role-aware defaults (Operator lands on the template gallery + status;
   Builder lands on the dense fleet + editor).
8. **Global `⌘K` command palette** + a sandbox quick-switcher.

### P2 — Trust, onboarding, differentiation
9. **Plan-before-execute + autonomy dial + plain-language permission prompts**
   (what/why/risk/decision) + cost/time estimates + isolation messaging.
10. **Template gallery & "Open in Atelier" deeplink** for the non-technical
    on-ramp; keep the JSONC editor as the Builder-mode advanced surface.
11. **Block-based terminal** rendering for navigable agent audit trails.
12. **Shareable read-only session/status pages** for execs + a demo run.

---

## 5. Proposed Visual Direction (starting tokens)

A concrete, ready-to-tune dark-first palette (swap into `index.css` tokens):

| Token | Value | Usage |
|---|---|---|
| `bg-base` | `#0d0c14` | App shell |
| `bg-surface` | `#17151f` | Cards, panels |
| `bg-elevated` | `#1e1c28` | Dropdowns, modals, terminal chrome |
| `border` | `#2d2b3a` @ low alpha | Hairline borders/dividers |
| `text-primary` | `#f0eef8` | Body |
| `text-muted` | `#8b89a0` | Labels, timestamps |
| `accent` | `#7c5cfc` | Primary actions, running |
| `success` | `#22c55e` | Healthy / done |
| `warning` | `#f59e0b` | Needs input / blocked |
| `danger` | `#ef4444` | Error / failed |
| `info` | `#3b82f6` | In review |

**Type:** Inter/Geist (UI) + JetBrains/IBM Plex Mono (code); 11px uppercase
tracked labels for status. **Motion:** 150ms ease-out status fades, 200ms card
entry, 2s gentle pulse on "needs input"; navigation instant (prefetch already
enabled via `defaultPreload: "intent"`). **Density:** medium default, compact
toggle for power users, spacious for operator mode.

> Note: these are *starting values to tune in context*, not gospel hex codes —
> the premium signal is the coherence and the microstates, not the specific
> numbers.

---

## 6. Status-Chip Vocabulary (use everywhere)

Standardize one set of semantic states across fleet, session, terminal blocks,
and notifications so color is pre-attentively scannable:

- 🟢 **Running / Done** — green
- 🟡 **Needs input / Blocked / Building** — amber (floats to top, pulses)
- 🔴 **Error / Failed** — red
- 🔵 **Ready for review / In progress** — blue
- ⚫ **Paused / Stopped / Archived** — gray

---

## 7. Persona Cheat-Sheet (design contract)

| Dimension | Builder (developer) | Operator (product / C-level) |
|---|---|---|
| Entry point | Fleet + JSONC editor + `⌘K` | Template gallery, "New run" wizard, shareable link |
| Density | High (logs, config, diffs, tokens) | Low (phase label, time/cost, summary) |
| Agent view | Terminal + raw progress + diffs | Plain-English progress + decision |
| Permissions | Full technical context | what / why / risk / decision |
| Errors | Stack trace + logs | One sentence + recommended next step |
| Nav | Keyboard-first | Click-first, large CTAs, wizard |

---

## 8. Suggested Sequencing

1. **Theme + type + microstates + terminal unification** (P0 1–3) — biggest
   perceived-quality jump for least structural risk.
2. **Empty states + onboarding selection flow** (P0 4, P2 10).
3. **Mission-control home + status chips + density toggle** (P1 5).
4. **Agent session surface (transcript + progress + inline plan/permissions)**
   (P1 6).
5. **Operator/Builder lenses + `⌘K`** (P1 7–8).
6. **Trust layer + block terminal + shareable pages** (P2 9, 11, 12).

Each step ships independently and improves the product on its own.

---

## Appendix A — Competitive Patterns Worth Stealing (condensed)

- **Vercel** — project-as-card grid with live status chips; three-tier empty
  state taxonomy; near-monochrome + Geist; instant SSR navigation.
- **Cursor 3** — "Agents Window" as mission control for parallel agent work
  (repo, env, task, diff count, status); local↔cloud handoff.
- **Devin** — Kanban command center (Running / Blocked / Ready for review);
  **Progress tab** that narrates steps above the raw shell; blocked cards
  surface the exact question.
- **Replit Agent** — Task Board state machine + **Queue**; explicit
  isolation-then-merge ("your main project is never touched until you apply").
- **Copilot Workspace** — **plan-first**, editable plan before execution;
  issue→PR anchoring (no blank empty state).
- **Gitpod** — active-first list with folded inactive; `gitpod.io/#URL` deeplink
  badge; startup-log streaming with progress during cold start.
- **Coder** — template-as-governance (admins define, devs self-serve) → maps to
  Atelier toolboxes/secrets; table view for high-volume power users.
- **Warp** — **block-based terminal**: command+output as navigable, copyable,
  bookmarkable blocks; jump straight to the failed step.
- **Linear** — status dot+label system; keyboard-first `⌘K`; per-entity accent;
  "the interface calms as the product grows"; craft in microstates.
- **Railway** — distinctive deep-indigo dark ("not just black"); low-anxiety,
  "ship peacefully" tone; virtualized streaming log viewer.
- **Stripe / Superhuman** — API/UI parity + `?`/`⌘K` shortcuts; 100ms
  responsiveness rule; "make the next action obvious."

## Appendix B — Sources

**Competitive & product UX**
- Vercel dashboard redesign & Geist empty states — vercel.com/changelog/new-dashboard-navigation-available, vercel.com/geist/empty-state
- Cursor 3 (Agents Window) — cursor.com/blog/cursor-3
- Devin Agent Command Center — docs.devin.ai/desktop/agent-command-center
- Replit Task Board / Queue — docs.replit.com/references/agent/task-board, replit.com/blog/introducing-queue
- GitHub Copilot Workspace — github.blog/news-insights/product-news/github-copilot-workspace/
- Gitpod list & deeplink — github.com/gitpod-io/gitpod/pull/10676
- Coder templates/list — github.com/coder/coder/issues/15398
- Warp blocks — warp.dev/modern-terminal
- Linear design refresh / method — linear.app/now/behind-the-latest-design-refresh, linear.app/method
- Railway design system — shadcn.io/design/railway

**Dual-audience, progressive disclosure & agent trust**
- NN/g Progressive Disclosure — nngroup.com/articles/progressive-disclosure/
- Syntasso — progressive disclosure in internal developer platforms
- WorkOS — multi-tenant permissions (Slack/Notion/Linear)
- Stripe Workbench — stripe.com/blog/workbench-a-new-way-to-debug-monitor-and-grow-your-stripe-integration
- Superhuman — 100ms rule & command palette — blog.superhuman.com
- Smashing Magazine — "Designing for Agentic AI" (intent preview, autonomy dial, handoff, outcome log)
- Agentic UX pattern libraries — agenticuxpatterns.com, uxpatternsguide.com, transparencypatterns.com
- ToolHalla — agent write-permission approval checklist

**Premium craft**
- Mantlr synthesis of Linear Method / Rauno Freiberg *Devouring Details* /
  Matt Ström-Awn's Stripe Dashboard — mantlr.com/blog/stripe-linear-vercel-premium-ui
- Linear "Details Matter" (Jan 2026); Karri Saarinen "10 Rules for Crafting
  Products"; Vercel Geist — vercel.com/font

*(Full, unabridged research briefs from the two research passes are available on
request — this appendix is the condensed, decision-oriented version.)*
