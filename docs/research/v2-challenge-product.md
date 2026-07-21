# Atelier v2 — Product Strategy Challenge

> **Role:** Senior product leader review. This document challenges the strategy, not the code.
> **Inputs:** `docs/proposals/atelier-v2.md`, `docs/research/control-plane-split-prior-art.md`, `docs/research/config-modeling-prior-art.md`

---

## 1. The Wedge: Feature List Masquerading as a Position

The stated wedge is: *"the open, self-hostable E2B/Daytona-class runtime, with credential rotation and local-config sync nobody else has."*

This is three separate things bolted together as if they're one coherent position. They're not.

**Self-hostable** is a deployment model, not a product feature. It implies a B2B enterprise motion — a platform team that has compliance requirements, existing Kubernetes infrastructure, and the operational capacity to run this. That is a real and underserved gap: none of the 10 surveyed platforms are self-hostable. But it's also a hard market to reach without a dedicated enterprise sales and support motion.

**Credential rotation** is a runtime quality-of-life improvement. E2B issue #1279 being open is evidence that it's annoying, not that it's a switching reason. Teams work around it with process restarts, short-lived tokens, or just accepting the friction. Nobody has publicly said "I would switch platforms if credential rotation worked." It's a retention feature, not an acquisition hook.

**"Sync my local agent config"** (`atelier sync ~/.claude`) is a CLI convenience. It's one `PATCH /files` call plus a local diff walk — the document says so explicitly. Any developer using E2B's existing API could script this in an afternoon. It is not a moat.

**The honest wedge is only one of the three: self-hostable K8s+Kata runtime.** That is real and defensible. But the proposal doesn't commit to it — it buries it under the other two features and then, confusingly, designs a product that individual developers would use, not the platform teams who do self-hosted Kubernetes deployments.

**Verdict:** The wedge is partially real (self-hosting) but undersold on its own terms and diluted by features that don't reinforce it. "Live credential rotation" and "sync my local config" are table-stakes quality improvements that belong in the product but should not be positioned as differentiation.

---

## 2. Who Is the Target User? (The Document Doesn't Know)

The proposal is written for three different users simultaneously:

| User | Where they appear | What they need |
|---|---|---|
| **Individual dev self-hosting** | `atelier sync ~/.claude`, `atelier attach sb_7f3a acp`, "continue my claude-code session in a clean workspace" | A polished product, opinionated defaults, low setup friction — not a K8s cluster to run |
| **Platform team at a company** | Self-hosted K8s+Kata, org-policy injection at the seam, `BYOC` framing implied | RBAC, template management, auditability, a UI for non-CLI users, SSO — not a CLI-first headless runtime |
| **Another product building on top** | Headless API, `SandboxSpec` as the contract, "your scripts / CI / n8n / Linear glue" | Stability guarantees, SDK, pricing clarity — not a CLI UX at all |

The self-hostable story only makes sense for the **platform team** user. But the product is designed around the **individual dev** user's workflow. These two users have completely different onboarding paths, different decision-makers, and different reasons to adopt.

A platform team deploying self-hosted infrastructure runs a procurement process, a security review, and an eval cycle measured in weeks. They want Coder-style organization management, template RBAC, and a UI their non-CLI developers can use. The CLI-first bet is the wrong answer for them.

An individual dev running their own K8s+Kata cluster to get a sandbox runtime is a fictional user. That person does not exist in meaningful numbers.

**Verdict:** The design serves the individual dev workflow but the positioning requires a platform team buyer. These are incompatible. The proposal needs to pick one user and serve them well, not three users adequately.

---

## 3. CLI/API-First: Strategic Strength or Adoption Risk?

The "kill the dashboard as mandatory surface" call is architecturally correct and strategically risky.

**What it gets right:** It forces API discipline. Every operation expressible through the CLI means the API is complete and testable. This is good engineering. It also correctly identifies that v1's dashboard was a false moat — it was not better than competitors' dashboards, it just existed.

**What it gets wrong:**

The addressable audience for "deploy self-hosted K8s+Kata via CLI" is extremely small and is already well-served by Coder, which has been doing exactly this since 2022 with Terraform-based templates, org management, an actual UI, and a much larger install base. Coder's design is also CLI-optional — the dashboard is first-class, not dead.

Eliminating the dashboard as a first-class surface costs Atelier the evaluation path that most products use to acquire users: someone finds it, runs a demo, sees value in 15 minutes, decides to adopt. A headless runtime with a CLI requires the evaluator to already understand what a sandbox runtime is and why they need one. That is a late-funnel posture, not an acquisition strategy.

**The identity problem is worse than the adoption problem.** When Atelier kills the dashboard as a product surface and commits to being a runtime, it stops being a product and becomes infrastructure. Infrastructure products compete on price, reliability, and ecosystem integration — not on "this is the best developer experience for agent workflows." The proposal's own framing ("the killer flow nobody else ships — replicate local agent setup") only has value if Atelier has an opinion about what that flow looks like. A runtime with no opinion about its users' workflows cannot own that story.

**Verdict:** CLI-first is the right call for the API design. Making it the *only* first-class surface is a mistake. The dashboard should die as a *form* (bespoke semantic tool manager), not as a *surface*. A spec editor + status board with a real onboarding UX is still a dashboard. It gives the product an identity that "a runtime" does not.

---

## 4. Composition-in-Client: Giving Away the Lock-In Surface

This is the highest-stakes strategic call in the proposal, and it deserves the most scrutiny.

The proposal pushes all composition — harness assembly, MCP server configuration, skills, vscode, the browser tool — into client scripts. The server is deliberately opaque: "The platform never knows what they are." This is elegant. It is also commercially dangerous.

**Why E2B and Daytona keep template/build UX server-side:**

Template IDs are the gravity center. When a developer builds `my-agent-template` on E2B, that template ID is baked into their code, their CI pipeline, their teammate's scripts. Switching away from E2B means rebuilding every template somewhere else. That is lock-in — not through walls but through accumulated state.

Atelier v2's `SandboxSpec` has no server-side gravity. A spec is a JSON file the client composes. Any wrapper script replicates it. There is no reason to prefer Atelier's CLI to a homegrown script that `POST /v1/sandboxes` the same spec. The "preset ecosystem" (phase 5) is explicitly "git-versioned, client-side" — zero server-side network effects, zero reason for a preset author to be tied to Atelier specifically.

**The devcontainer comparison is incorrect as a business analogy.** devcontainers succeeded as a client-side composition model because it is an open standard, not a product. A standard's success is measured by adoption and interoperability, not by one company capturing value. Atelier is a product. The lesson from devcontainers is that open, client-side composition drives ecosystem adoption — but that's the wrong goal for a company that needs to capture value.

**What Atelier is giving away:**

The actual differentiable surface for an agent-focused sandbox product is knowing what is running in the sandbox. Which harness, which MCP servers, which skills. That knowledge enables:
- Better observability ("your opencode session is consuming 4 MCP calls/second")
- Better defaults ("add the GitHub MCP" as a one-click operation that works)
- Better billing ("you're using the Linear skill in 12 sandboxes")
- Better upgrade paths ("opencode 1.17 is available for 8 of your sandboxes")

The proposal acknowledges this with `annotations` (display hints), then immediately says the runtime never reads them. That is the right call architecturally. But it means the product has no business value in that layer — the value is fully in the client, which Atelier does not own.

**Verdict:** Composition-in-client is architecturally sound and commercially self-defeating. It produces a runtime that is impossible to lock users into, in a market where the dominant players' moats are template registries and saved configs. The proposal is commoditizing its own core.

---

## 5. Opportunity Cost: Runtime vs. Product

The prior-art research is explicit on this point (§4 of `control-plane-split-prior-art.md`): "the low-level API was not designed first — it was extracted after the product proved its shape." Fly, E2B, and Nomad all validated this pattern. Atelier v2 is designing the extracted API first, before the product has proven its shape.

**The well-funded hosted players are not standing still.** E2B will close issue #1279. Modal already has credential injection. Fly's Machines API is more mature than anything Atelier can ship in 6 months. The self-hosting gap is real today; it will shrink as these platforms add BYOC tiers. The window for "self-hosted runtime" as a differentiator is measured in 12–18 months, not indefinitely.

**The valuable thing to build — and the thing the v1 POC validated — is a great agent development environment.** That means: opinionated defaults for agent workflows, integrated observability of what's happening in sessions, a product that knows whether you're running opencode or claude-code or a custom harness and surfaces that. v1 proved demand. The lesson from v1 should be "fix the opinionation, not the structure" — not "eliminate all opinionation and become a runtime."

A generic compute primitive competing head-on with Modal and E2B on the self-hosting axis requires winning a procurement process at enterprise companies, requires operational support for K8s upgrades, requires SLA guarantees. That is a fundamentally different company than one building a great agent dev product.

**Verdict:** The v2 architecture sets the team up to build a generic compute primitive in a market already crowded with well-funded players who have head starts. The opinionated agent-focused product direction — the valuable thing that v1 actually validated — gets sacrificed to the elegance of "everything is content."

---

## Summary Assessment

**The wedge:** Partially real. Self-hostable is genuine. The other claimed differentiators (credential rotation, local sync) are table-stakes quality improvements. The wedge should be stated cleanly as "the self-hosted option for teams that can't or won't use hosted sandboxes" — and the product should be designed for that buyer, not for individual devs.

**Target-user clarity:** Failing. The proposal serves three users and designs for none of them well. The self-hosting thesis requires a platform team buyer; the workflow design requires an individual dev user; the headless API requires a platform-builder customer. Pick one. The strongest candidate given actual market gap: the platform team at a company with a Kubernetes footprint, AI tool sprawl, and no way to standardize agent development environments — which is a Coder-adjacent motion, not an E2B-adjacent one.

**Biggest strategic risk:** Composition-in-client eliminates the gravity center. There is no server-side state that creates switching costs. A clean headless API is easy to migrate away from by definition. This is not a viable commercial architecture unless Atelier intends to be open-source infrastructure (a legitimate but different business model that should be named explicitly).

**Does the architecture serve the product?** No. The product got redefined to fit an elegant architecture. "The runtime never knows what they are" is technically pure and commercially empty. The features users would pay for — integrated agent observability, opinionated presets that actually work, a session that knows it's running opencode — were removed to preserve the no-typed-schema principle. The architecture is correct for a platform infrastructure product. Atelier is not, and should not try to be, a platform infrastructure product.

**One concrete recommendation:** Before committing to the full v2 direction, run a 30-day test. Pick three companies who said they'd pay for a self-hosted agent sandbox. Find out whether the blocker is "no credential rotation" or "can't use hosted services." If the answer is the latter, the self-hosting bet is real and the architecture is appropriate. If the answer is the former, Atelier needs an opinionated product, not a headless runtime.
