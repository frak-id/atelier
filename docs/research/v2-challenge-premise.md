# Adversarial Challenge: Atelier v2 "Knows Nothing" Premise

> **Purpose:** Challenge the load-bearing premises of `docs/proposals/atelier-v2.md`.
> Not a rewrite proposal — a stress test. Findings are grounded in
> `docs/research/config-modeling-prior-art.md` and
> `docs/research/control-plane-split-prior-art.md`, and compared against the
> journey in `generic-sandbox-architecture.md` and `generic-sandbox-profiles.md`.

---

## The Thesis Under Test

> "Atelier v2 is a headless sandbox runtime that knows nothing; harness/MCP/
> skills/editor/VNC are all just user-defined files+processes+ports."

Broken into its testable sub-claims:

1. The runtime knows nothing semantic — it executes primitives blindly.
2. Composition-in-the-client is a genuine "thin client" win, not duplication.
3. `annotations` are inert display hints that do not encode behavior.
4. The unstated dependency chain is sound (stateless composition, no
   cross-cutting semantic awareness needed, opaque metadata survives real use).

---

## 1. Is "The Runtime Knows Nothing" Actually True?

### 1.1 `stdio: "bridge"` — The Named Special Thing

The spec shows:

```jsonc
{ "name": "acp", "command": "opencode acp", "stdio": "bridge" }
```

The doc claims the bridge is "protocol-transparent (a byte relay, never parses
JSON-RPC)." But `stdio: "bridge"` is a **named enumerated mode** — a value the
runtime must recognize and act on differently from a process without it. The
runtime does not treat all processes identically: it must:

- Allocate a WebSocket endpoint for this process.
- Route incoming WS frames to the process's stdin.
- Route stdout bytes back as WS frames.
- Enforce the "single-writer" attach semantics.

The name "bridge" is in the schema. The runtime dispatches on it. Saying the
bridge "never parses JSON-RPC" is accurate but beside the point — the runtime
still knows that *this class of process* gets WS relay infrastructure, and *other
processes* do not. That is semantic knowledge about process topology.

**Verdict:** `stdio: "bridge"` is a named behavioral variant. The runtime knows
that some processes are WS-relay sinks. The "knows nothing" claim is false here.
The more defensible claim would be: "the runtime knows nothing about *what the
protocol inside the bridge means* — but it does know which processes are
bridge-attached."

### 1.2 `auth: "forward"` on Ports

```jsonc
{ "name": "vscode", "port": 8080, "public": true, "auth": "forward" }
```

The runtime must dispatch on `auth: "forward"` to behave differently from a port
with no auth. `"forward"` means: proxy the request's auth token upstream rather
than terminating auth at the ingress. This is a named authentication policy with
behavioral consequence. The runtime's ingress/proxy layer must implement it.

This is not opaque. The runtime knows two things it is not supposed to know:
(a) that some ports require auth enforcement and (b) what "forward" means
mechanically.

**Verdict:** `auth: "forward"` is a runtime-enforced behavioral mode, not a
decoration. Schema leak #1.

### 1.3 `hooks.onResume` — Lifecycle Semantic Awareness

```jsonc
"hooks": { "onResume": ["~/.atelier/refresh-tokens.sh"] }
```

The doc states this is "a core primitive, not a nicety" because "pause/resume
drops all network state and restores *expired* credentials." Correct — and that
is precisely the point: the runtime must *know* that this hook fires only on
resume (not on first boot, not on postStart) because it must understand the
credential-expiry semantics of the pause/resume lifecycle.

The runtime does not execute hooks blindly. It executes them phase-conditionally,
and the phases carry semantic meaning: `postCreate` ≠ `postStart` ≠ `onResume`.
The runtime knows the difference between a sandbox starting fresh and a sandbox
returning from a paused state — and it acts on that knowledge to decide which
hooks to run.

The broader claim — "the runtime's job is `prebuild → boot → pause → resume →
clean`" — *directly contradicts* "the runtime knows nothing." The runtime knows
the lifecycle state of a sandbox by definition, and it uses that knowledge to
schedule hook execution. This is not a flaw; it is unavoidable physics. But it
punctures the "knows nothing" slogan.

**Verdict:** Phase-conditioned hook execution requires semantic knowledge of
lifecycle state. This is correct behavior and good design — but it is not "knows
nothing."

### 1.4 Per-Process Liveness and Port-Bind Health

The doc deletes `boot-waiter.ts` ("hardcoded opencode `/health` readiness gate")
and replaces it with "generic per-process liveness (+ optional port-bind check)."

A port-bind health check (`process X is ready when it binds port P`) requires the
runtime to understand:
- Process ↔ port relationships (a process "owns" a port for readiness purposes).
- What "ready" means (vs. "running" vs. "crashed").
- Boot sequencing (processes may have readiness dependencies).

The runtime must know that sandbox boot is not complete until specific processes
declare liveness. That is not nothing — it is exactly what a Kubernetes readiness
probe is, and K8s makes no pretense of being "topology-agnostic" with respect to
readiness.

**Verdict:** Generic liveness still requires the runtime to model process
health as a concept. Eliminating the *specific* opencode health gate is an
improvement; claiming the replacement knows nothing is not accurate.

### 1.5 `attach: single-writer` — Session State Tracking

> "Attach is single-writer. The stdio-bridge allows one writing client at a time."

The runtime must track: which client (if any) currently holds the write lock on a
bridge-attached process. This requires per-process session state in the runtime —
a connected concept, not a generic primitive. The runtime does not treat all
WebSocket connections identically: it admits the first writer and demotes
subsequent ones to read-only or rejects them.

**Verdict:** Single-writer semantics require runtime-level session state about
process attachment status. Not nothing.

---

## 2. The `annotations` Escape Hatch — Schema Leaking Through the Side Door

```jsonc
"annotations": {
  "atelier.dev/harness": "opencode",
  "atelier.dev/mcp": "linear,github"
}
```

The doc says: "The runtime never reads them either; clients that *compose* a spec
are encouraged to tag what they composed... Untagged specs render generically and
work identically."

### 2.1 The Structural Problem

If the runtime truly never reads annotations, they do not belong in the spec the
runtime receives. They belong in a side-channel metadata store (like the
`metadata` field the doc already has for observability pass-through). Putting them
in the spec creates a path for future runtime code to read them — and the doc
even invites it: "so the dashboard can render 'opencode with the linear MCP'
instead of just 'a process named acp'."

But the dashboard cannot be the only reader in perpetuity. Every real use case
that needs runtime behavior tied to what a harness IS will reach for annotations:

- **Health routing**: "restart the harness process when this annotation says
  `atelier.dev/harness: opencode`."
- **Billing**: "charge harness-tier pricing when this annotation is present."
- **Observability**: "tag traces with harness name from annotation."
- **Policy injection**: control's "org-policy injection" step could condition on
  `atelier.dev/harness` to append harness-appropriate policy files.

The Kubernetes analogy the doc invokes ("Fly-labels/K8s-annotations compromise")
is instructive but in the wrong direction. K8s annotations were also designed as
"opaque metadata" — and they are now routinely read by Istio, CNI plugins, cert-
manager, admission webhooks, the scheduler itself (via node affinity annotation
conventions), and dozens of ecosystem tools. The K8s annotation ecosystem is
exhibit A for how "opaque metadata" becomes a typed schema through the side door.

### 2.2 The Admission: Insufficiency of Pure Primitives

The fact that the doc *needs* annotations to make the dashboard useful proves
the pure-primitive model is insufficient for the stated product goals. The
dashboard is described as rendering "opencode with the linear MCP" — a
semantically rich rendering that requires knowing what `acp` is. If the runtime
truly knew nothing, the dashboard would render "a process named acp on port
forwarded via stdio bridge." That would be accurate but useless.

Annotations are the product's way of smuggling "the runtime knows what a harness
is" back into the spec while maintaining the fiction that the runtime doesn't use
it. The fiction is currently correct (the runtime doesn't read them yet) but it is
a promise with a predictable expiration date.

**Verdict:** `annotations` are proto-schema. The pure-primitive model is
insufficient for the product's own dashboard and observability requirements. The
"knows nothing" claim will be false at the first billing, health-routing, or
trace-labeling feature. The question is not *whether* annotations get read by the
runtime; it is *when*.

---

## 3. Composition-in-the-Client: What Actually Breaks

### 3.1 The Duplication Problem Is Real

The doc claims: "Composition happens in the client, not the server." Three clients
are named: the CLI, the dashboard, and the MCP server. Plus: "your scripts / CI /
n8n / Linear glue / company wrapper scripts."

Every one of these must contain the logic to compose a valid `SandboxSpec` for an
opencode sandbox. That logic is not trivial:

- Which `files` entries does opencode need? (`.claude/settings.json` with what
  schema? `opencode.json` with what fields?)
- What is the correct `command` for the ACP process? (`opencode acp` today, but
  what version flags? What env?)
- Which ports does the opencode web UI bind? (The doc mentions port 8080 for
  vscode in the example — what about opencode's web UI port?)
- What MCP config file format does opencode consume, and at what path?

This is exactly the knowledge that `harness-adapter.ts` currently encodes in one
place. The doc's migration plan says:

> "harness-adapter.ts, shared/lib/opencode-*.ts, opencode-warmup.ts → Move
> client-side. Adapters become spec composers."

"Move client-side" means: replicate this knowledge across the CLI, the dashboard,
and every company wrapper script that wants opencode support. The knowledge is not
eliminated — it is scattered.

### 3.2 Versioning Across N Clients

When opencode changes its config file path or its ACP command flags:

- v1 runtime model: update `harness-adapter.ts` in one place.
- v2 client-composition model: update the CLI spec composer, the dashboard spec
  composer, the MCP server spec composer, and every company wrapper script.

The doc presents this as clients being "thin" — but the thickness has been moved,
not reduced. The question is whether it is better to have one thick server or N
thick clients. For internal clients (CLI + dashboard) the answer is ambiguous. For
external clients (company scripts, third-party integrations), scattering the
composition logic is objectively worse for the ecosystem.

### 3.3 Where "Thin Client" Wins Are Genuine

The claim is not entirely wrong. For the substrate-level spec (image, resources,
env, processes as bare commands, ports as integers), the client-composition model
is a genuine win — this is exactly the pattern Fly.io (Machines API) and E2B use
successfully. The runtime truly does not care.

The problem is harness-specific assembly: which files to write, what config
format, what flags to pass. That is not "composing primitives" — that is encoding
application knowledge in config. And application knowledge drifts if it lives in
N clients.

### 3.4 The Honest Caveat the Doc Does Not Make

The doc notes that devcontainers "keeps some typed fields — `forwardPorts`,
`customizations.vscode.*`" and frames v2 as going further toward purity. But
`customizations.vscode.*` exists precisely *because* composition-only-in-client
broke down for VS Code extensions: every client that wanted to configure VS Code
had to know the extensions JSON schema, and the community consolidated that into
the spec. The typed fields are the evidence that composition-in-client produces
consolidation pressure over time.

**Verdict:** Composition-in-the-client is a genuine win for infrastructure
primitives (image, resources, generic processes, ports). It is a duplication
problem for application-layer knowledge (harness config formats, MCP schemas).
The doc conflates these and treats all composition as the same kind of thing.
The concrete failure scenario: opencode ships a new config schema; three clients
diverge; a company's wrapper script creates broken sandboxes for three weeks until
someone notices.

---

## 4. Unstated Assumptions That the Doc Does Not Defend

### 4.1 Composition Is Genuinely Stateless

The doc says control performs "bounded spec enrichment" — secret resolution and
org-policy injection. But org-policy injection is described as: "append operator-
mandated entries (an audit process, a compliance file) from a per-org policy
spec."

If an org's policy depends on *what the client composed* (e.g., "if harness=
opencode, append this compliance file; if harness=something-else, append a
different one"), then the policy injection step must read the spec semantically.
The doc provides no mechanism for conditional policy injection — it just says
"append." The assumption that policies are unconditional (every sandbox in this
org gets the same compliance file regardless of what it runs) is unstated and
probably false for real enterprise customers.

### 4.2 "Metadata Is Opaque" Survives Billing and Observability

The doc says: "The runtime threads [metadata] through for observability and never
reads it."

Real observability and billing require the runtime to emit structured signals with
semantic labels. A billing system that charges "per harness-hour" needs to know
which sandboxes are running a harness. An observability system that needs to page
the right on-call when "the harness process dies" needs to know which process is
the harness. "Thread opaque metadata through" means the runtime emits a blob and
something else reads it — but that "something else" must decode the opaque blob
and act on it, which is the semantic knowledge just moved one hop away.

The claim survives only if billing and observability are coarse (charge per
sandbox-hour, alert on any process exit). At that resolution, opaque is fine.
As product matures toward per-harness metering or harness-aware health alerting,
the assumption collapses and the semantic knowledge must enter somewhere.

### 4.3 The `/opt/shared` Catalog Is Someone's Problem

The doc's prebuild model depends on: "Binaries a process references must be
pre-staged (in the snapshot, or on the shared read-only catalog volume
`/opt/shared`)."

Phase 4 of migration replaces Helm `sharedBinaries.*` with an admin CLI verb:
`atelier catalog add opencode@1.17 --sha256 ...`. This creates a new operational
responsibility: before any sandbox can boot with opencode, a human must have run
this command. In v1, Helm chart deployment guaranteed the binaries were present.
In v2, the catalog is an operational dependency that is not automatically
satisfied.

The doc acknowledges this dependency but presents the admin CLI as the solution
without examining the failure mode: what happens when a client composes a spec
referencing `opencode@1.18` and the catalog contains only `1.17`? The spec passes
validation (the runtime doesn't know what opencode is), the process fails to
start at boot, and the failure surfaces as "command not found" — not as a schema
error that could have been caught earlier. The pure-primitive model loses static
validation that a schema-aware model would provide.

### 4.4 No Cross-Cutting Concern Needs Runtime Process-Type Awareness

The assumption: you can run a harness, a dev server, an MCP bridge, and a VNC
server as equivalent named processes, and no platform feature will ever need to
distinguish between them.

This is false in at least three dimensions:

**Security**: A harness process typically needs outbound network access to LLM
APIs. A dev server typically does not need to make arbitrary outbound requests. A
VNC server needs no network egress. If the runtime modeled process types, it could
enforce different egress policies per type. With the "all processes are equal"
model, you either give all processes the same (permissive) egress policy, or you
implement this via process-name conventions that the runtime reads — which is
schema leaking through a different door.

**Restart policy**: If the harness dies, the sandbox is functionally broken (no
one can control it via ACP). If a dev server dies, the sandbox continues
functioning and the developer can restart it. Equal restart policies lose this
distinction. The spec has `"restart": "on-failure"` per process, which helps, but
deciding the right policy requires knowing what the process *is* — which the
client must encode redundantly across all composition paths.

**Resource attribution**: When a sandbox consumes 8GB of memory, is it the LLM
harness, the dev server, or the VNC stack? Opaque process attribution (by name
only) makes resource debugging hard. Named process types make it machine-readable.

---

## 5. Steelman: The Runtime That DOES Know First-Class Concepts

Consider an alternative design — call it "v2-aware" — where the runtime models
two first-class concepts alongside the generic primitives:

- **`harness`**: the controlled AI process (one per sandbox; the ACP bridge is
  its stdio relay; it has liveness primacy — sandbox health = harness health).
- **`exposed-app`**: a user-facing service (port, auth mode, public/private,
  optional healthcheck URL).

Everything else remains generic processes and ports. The spec would look like:

```jsonc
{
  "source": { "snapshot": "snap_ws-frak-7f3a" },
  "resources": { "vcpus": 4, "memoryMb": 8192 },
  "harness": {
    "command": "opencode acp",
    "readiness": { "port": 8080, "path": "/health" }
  },
  "exposedApps": [
    { "name": "vscode", "command": "code-server ...", "port": 8080,
      "auth": "forward", "lazy": true },
    { "name": "web",    "port": 5173, "public": true }
  ],
  "processes": [
    { "name": "worker", "command": "bun run worker", "restart": "on-failure" }
  ],
  "files": [...],
  "env": {...},
  "hooks": { "onResume": ["~/.atelier/refresh-tokens.sh"] }
}
```

### Where This Beats v2

**1. Harness liveness is first-class.** The runtime gates sandbox "healthy" on
harness readiness without requiring the harness to be found by process-name
convention. Observability (`sandbox.status = harness_crashed`) is machine-
readable without parsing annotations.

**2. Billing is accurate without annotations.** The runtime knows which sandboxes
run a harness. Usage metrics are structural, not inferential.

**3. Composition logic lives in one place.** Clients compose the `command` and
`files` for the harness, but the semantic wiring (stdio bridge, liveness, health
gate) is declared once and enforced by the runtime. The CLI and dashboard do not
each need to remember to add `stdio: "bridge"` to the ACP process.

**4. Security policy is process-type-aware.** The runtime can apply different
egress rules to `harness` vs. `exposedApps` vs. generic `processes` by type,
without the client needing to enumerate per-process network policies.

**5. Static validation catches catalog gaps.** If the runtime knows that
`harness.command` references a binary, it can validate at spec submission time
that the binary exists in the catalog — a schema-level error rather than a
runtime "command not found."

### Where v2 Still Beats v2-aware

**1. Schema evolution tax.** "harness" and "exposed-app" will need versioning as
the concepts evolve. v2's pure-primitive model never accrues this tax.

**2. Novel workloads fit without schema changes.** A sandbox that runs two AI
agents (no single "harness") is straightforward in v2 (two named processes).
v2-aware needs a schema decision: one harness per sandbox, or an array?

**3. Implementation cost.** First-class concepts require the runtime to implement
type-specific behavior. v2's runtime is genuinely simpler to implement and reason
about.

**4. Prior art supports primitives at the compute layer.** The research is
correct: Firecracker, containerd, the Machines API — the lowest compute layer
always wins by staying generic. The question is whether the layer *above* the
runtime (what v2 calls "control") should absorb the first-class concepts.

**Honest verdict:** v2-aware would beat v2 on observability, billing accuracy, and
composition locality for harness-type knowledge. It would lose on schema evolution
flexibility and novel-workload fit. The right answer might be a narrow middle
ground: **one typed concept in the runtime (`harness` or `primary-process`)**
with everything else remaining generic — rather than either "nothing typed" or
"harness + exposed-app typed."

---

## 6. Load-Bearing Premises: Solid vs. Shaky

### Premise 1: Generic primitives (files/env/processes/ports/hooks) are the correct runtime vocabulary.

**SOLID.** This is the strongest claim in the doc. The prior-art survey of 10
platforms is genuinely unanimous, and the platforms that tried richer typed schemas
retreated. The runtime should not have `mcp[]`, `skills[]`, or `harness.type`
fields. The intermediate proposals were wrong here and the doc is right to kill
them.

### Premise 2: The runtime knows nothing about what the primitives represent.

**SHAKY. Half true.** The runtime knows:
- That some processes are stdio-bridge-attached (and routes WS traffic accordingly).
- That `onResume` hooks fire on resume, not on first boot (lifecycle semantic).
- That `auth: "forward"` means proxy auth upstream (behavioral mode).
- That port-bind health checks tie process state to sandbox readiness.

These are not eliminable — they are the mechanisms that make the primitives useful.
The defensible version of this claim is: "the runtime knows nothing about *the
content* of the primitives — it does not parse ACP JSON-RPC, does not understand
MCP topology, does not read harness config files." That is a materially weaker
but accurate claim.

### Premise 3: Composition-in-the-client is a genuine thin-client win.

**CONDITIONALLY SOLID, with a real failure mode.** For infrastructure composition
(image, resources, generic processes, ports), it is correct and matches the
industry pattern. For application-layer knowledge (harness config formats, MCP
schema paths, ACP command flags), it creates duplication across N clients that
drifts as the harness evolves. The failure mode is: opencode changes config schema
→ CLI updates → dashboard lags → company scripts never update → broken sandboxes
in the wild. This is not hypothetical; it is the standard "distributed schema"
failure mode.

### Premise 4: `annotations` are inert display hints that do not affect behavior.

**SHAKY. Currently true, predictably false.** Annotations are currently unread
by the runtime. The first billing, health-routing, or observability feature that
needs to know "what is the harness" will read them. The K8s annotation precedent
is not encouraging. The doc's own dashboard use case (rendering "opencode with
linear MCP") requires the dashboard to read annotations — which means annotations
already affect behavior (rendering, UX decisions). Claiming they "never" affect
behavior is only defensible at the narrow scope of the Rust runtime agent.

### Premise 5: Org-policy injection ("bounded spec enrichment") keeps composition clean.

**SHAKY for real enterprises.** The doc describes policy as unconditional appends.
Real org policies are conditional on what's being run (different compliance
requirements for AI harnesses vs. dev servers). Unconditional append works for
today's single-tenant or single-harness environment. It breaks when multiple
harness types or workload classes share a org with differentiated policy.

---

## 7. Concrete Failure Scenarios

**Scenario A: The Harness Config Drift Problem**
opencode ships `v1.20` with a new config file path. The CLI spec composer is
updated. The dashboard spec composer misses the PR. Dashbboard-spawned sandboxes
silently boot with a broken harness config for two releases. With server-side
harness knowledge, there is one update point. With client-composition, there is
no single source of truth to update.

**Scenario B: The Annotation Creep**
The team ships per-harness billing. The billing system reads
`annotations["atelier.dev/harness"]` at the runtime layer. Six months later,
a sandbox spec is submitted without annotations (a company's custom client that
did not add the annotation). It is billed at the wrong tier with no error.
Annotations-as-behavior with no validation or schema guarantee silently
misbills. A typed `harness` field would fail-fast at spec validation.

**Scenario C: The Catalog Gap at Boot**
A developer uses the CLI to compose a spec referencing `opencode@1.19`. The
catalog contains `opencode@1.17`. The spec validates (runtime knows nothing about
what binaries exist). The sandbox boots. The harness process silently fails
with "command not found." The sandbox appears "running" with no harness attached.
The developer spends 20 minutes reading logs before discovering the catalog gap.
A schema-aware runtime would reject the spec at `POST /sandboxes` with:
`"harness binary opencode@1.19 not found in catalog"`.

**Scenario D: Conditional Org Policy**
A regulated customer has two workload types: AI sandboxes (require data residency
audit logging) and dev sandboxes (do not). Org policy injection appends the audit
process to every sandbox. The developer-facing dev sandbox now runs an unwanted
audit process. The alternative — conditional injection based on `annotations`
content — requires the control layer to parse and act on annotations, making them
behavioral through the back door.

---

## 8. Blunt Verdict

**The "knows nothing" framing is overstated and partly a comforting fiction.**

The runtime cannot know nothing: it knows lifecycle phases (and uses them to
schedule hooks), it knows process attachment modes (and implements WS relay
infrastructure for bridge-attached processes), and it knows auth semantics for
ports. These are not eliminable — they are the mechanisms that justify building a
runtime rather than just using raw Kubernetes pods.

The *defensible* version of the thesis is:

> "The runtime knows only mechanism, not content. It knows that some processes get
> a WS relay, that `onResume` hooks fire after a resume, and that some ports proxy
> auth — but it does not know what ACP *means*, does not parse harness configs,
> and does not model 'harness' or 'MCP server' as typed entities."

That is a weaker but honest claim, and it is genuinely valuable design discipline.

**The composition-in-client bet is correct for primitives, risky for harness
knowledge.** The prior-art survey supports it at the infrastructure layer. It will
produce duplication and drift for application-layer knowledge (harness config
formats) unless the harness-adapter logic is canonically packaged and reused
across clients (an SDK or shared library), which the doc does not address.

**The annotations escape hatch proves the pure-primitive model is insufficient**
for the product's own dashboard and observability goals. This is not a damning
flaw — it is an honest tradeoff. But calling annotations "inert display hints"
while designing a dashboard that renders semantic UI from them is having it both
ways.

**The steelman alternative (one typed first-class concept: `harness`) would
outperform v2 on billing accuracy, health observability, composition locality for
harness knowledge, and static catalog validation.** It would perform worse on
schema evolution flexibility and novel-workload fit. Whether that tradeoff is
worth taking depends on how central the harness concept is to the product
definition — and for a platform whose market position is "the sandbox for AI
agents," a typed harness concept is not gratuitous; it is the product.

**Recommended adjustment:** adopt v2's primitives-first runtime, but promote
`harness` to a typed first-class field alongside the generic process list (not
instead of it). Keep MCP, skills, tools, editor, VNC as generic processes and
files. This narrows the schema to one concept the product genuinely needs to
reason about, avoids the annotation creep failure mode, and preserves the rest of
the "knows nothing" discipline.

---

## Appendix: Mapping Claims to Evidence

| Claim in v2 doc | Status | Evidence |
|---|---|---|
| "No typed harness/mcp/skills fields" | **SOLID** | Prior-art unanimous; retreats from rich schema confirmed |
| "bridge is protocol-transparent" | **MISLEADING** | `stdio: "bridge"` is a named runtime dispatch mode |
| "`auth: 'forward'` is a thin annotation" | **FALSE** | Runtime must implement proxy-auth behavior |
| "onResume is phase-scheduled" | **SOLID** (but concedes runtime knows lifecycle) | Unavoidable; correct design |
| "annotations never affect behavior" | **CURRENTLY TRUE, FRAGILE** | Dashboard semantics already read them; billing/health will too |
| "composition in client is a thin-client win" | **CONDITIONALLY TRUE** | True for infra primitives; false for harness config knowledge |
| "metadata is opaque" | **WORKS TODAY, BREAKS AT BILLING** | Coarse billing is fine; per-harness metering requires reading it |
| "org-policy injection is two bounded steps" | **WORKS FOR HOMOGENEOUS ORG** | Conditional policies by workload type cannot be expressed |
