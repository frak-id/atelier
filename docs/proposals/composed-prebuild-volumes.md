# Two-Tier Prebuilds — Repo Snapshots + Toolset Artifacts

Status: **proposal — refines the prebuild model in
[`atelier-v2.md`](./atelier-v2.md) §2 ("Prebuild economics", "Layered
prebuilds"). Additive: keeps `prebuild()` + content-addressing for the repo
tier; introduces a second, registry-backed artifact tier for toolsets.
Supersedes the earlier side-mounted-volumes draft of this document.**

Inputs: `apps/server/src/runtime` audit (`runtime.service.ts`, `boot.ts`,
`kube/kube.resources.ts`), `packages/spec` (`sandbox-spec.ts`,
`prebuild-spec.ts`), `infra/k8s/v2` (shared-binaries, zot registry config).

---

## 0. The problem: one lineage, two axes with different physics

v2 today composes expensive setup by **chaining snapshots** — a prebuild's
`source` is an image *or another snapshot ref*, so every layer bakes on top
of the last into one root-filesystem lineage (`prebuild-spec.ts`,
`runtime.service.ts:99`). `atelier-v2.md:277` admits the cost: genuinely
distinct per-dev setups are O(devs) snapshots, and the real risk is
node-locality — TopoLVM snapshots are node-local, so every baked layer is a
node-pinned object whose "instant boot" silently regresses when its node is
full or drained.

The deeper issue is that chaining forces **two axes with different physics
into one storage mechanism**:

| Axis | Contents | Size | Change cadence | Who shares it |
|---|---|---|---|---|
| **Repo** | clone + deps (`node_modules`, …) | GBs | every push (commit hash) | all devs on the repo |
| **Toolset** | harness, MCPs, skills, plugins, prefs (pi, opencode, claude-code…) | 100s of MB | when the dev updates tools | one dev — or an org preset |

Product goals make the axes non-collapsible:

- **Per-dev toolchain freedom is a hard requirement.** Devs on the same org
  pick their own harness/MCPs/skills. Hard-locking an org onto one
  toolchain is a no-go.
- **No-clicks experimentation.** "Found a new repo-indexing MCP → boot a
  sandbox with my usual git workspace and toolchain → play" must be one tap.
- **Non-tech sandboxes.** Product/C-level sandboxes = repo ⊕ org toolbox ⊕
  vscode preset, spawned from a saved spec.
- **Independent invalidation.** A repo push must rebuild the repo prebuild
  without touching anyone's tools; `pi update --all` must update a toolset
  without touching any repo prebuild.

Chained into one lineage, an org with R repos and D devs trends toward
**R × D node-pinned snapshots**, and either axis changing invalidates the
other's bake. The target shape is **R + D**.

## 1. The reframe: repo tier is storage, toolset tier is an artifact

Do **not** make toolsets a second kind of VolumeSnapshot mounted beside the
workspace (the earlier draft of this doc). That inherits three structural
problems: snapshots are node-local (a sandbox would need repo ∧ toolset
snapshots co-located — an AND placement constraint, with no replication
machinery in the cluster; `shared-binaries` is a single RWO `local-path`
PVC, not a replication system); toolsets would have to be *relocatable* to a
disjoint mount path, which fights how real installers work (pi, opencode,
npm plugins scatter bytes across `~/.local`, `~/.config`, `~/.npm`, rc
files); and pause/snapshot semantics (`runtime.service.ts:278,455`) would
fracture across N volumes.

Instead, give each axis the mechanism that matches its physics:

| Tier | Mechanism | Keyed by | Placement | Count |
|---|---|---|---|---|
| **Base** — OS, system packages (`/usr`, `/etc`) | image (or one base snapshot) | image tag/digest | any node (image cache) | 1 |
| **Repo** — clone + deps | `prebuild()` → VolumeSnapshot → CoW clone (unchanged) | `hash(base ⊕ repo@commit ⊕ build[])` | node-local (as today) | R |
| **Toolset** — harness, MCPs, skills, prefs | **content-addressed archive in the in-cluster registry** (zot, `infra/k8s/v2/30-config.yaml:38`), **materialized by the guest agent at boot** into the real home paths | result hash (captured) or input hash (built) | **any node** — pulled from in-cluster zot (no node cache in v1, §3) | D + org toolboxes |

Key properties:

- **Toolsets never participate in placement.** They are registry blobs, not
  node-local snapshots. Any node can pull them from the in-cluster registry.
  The node-locality problem exists only where it already exists today (repo
  snapshots).
- **Tools land at their native paths.** The agent extracts into
  `~/.local/…`, `~/.config/…`, etc. — no relocation discipline, no
  "packaged relocatable toolset" tax. A captured toolset is just "the paths
  this setup touched."
- **Pause/snapshot semantics are untouched.** By the time processes start,
  everything is bytes in the single home PVC. `pause()`, `resume()`,
  `snapshot()` keep their exact current meaning — zero changes to that code.
- **System packages stay in the base.** apt/`/usr` mutations cannot be a
  home-path artifact and must not be in per-repo prebuilds. They live in the
  base image where they are shared by everyone and never a matrix axis. A
  spec needing extra system packages is a *different base* (slow once).

## 2. The toolset artifact

A toolset is a content-addressed tarball (OCI artifact in zot is the natural
encoding — free dedup, GC, auth, and any-node pull) plus a small manifest:

```jsonc
// toolset manifest (stored with the artifact; content, owned by compose)
{
  "name": "alice-pi-stack",
  "version": "2024-06-01T…",           // or a semver for org toolboxes
  "paths": [                            // path-sets captured/materialized
    "~/.local/share/pi", "~/.local/bin/pi",
    "~/.config/pi", "~/.claude/skills"
  ],
  "env": { "PATH": "~/.local/bin:$PATH" },   // fragment merged at compose time
  "provenance": { "capturedFrom": "sb_7f3a" }   // or { "build": ["…"] }
}
```

Two ways a toolset comes to exist, both first-class:

1. **Captured (result-keyed).** The no-clicks flow: boot a sandbox, `pi
   update --all` / install the new MCP / tweak configs, then capture:

   ```bash
   atelier toolset capture sb_7f3a --name alice-pi-stack
   # agent diffs the declared path-sets against the materialized baseline,
   # tars the delta, pushes to the registry, returns a content hash
   ```

   Honest classification: a captured toolset is an **artifact, not a
   derivation** — keyed by result, not by inputs. Evict it and it cannot be
   rebuilt automatically. Consequence: captured toolsets are never GC'd
   silently (explicit delete only), while built toolsets are freely
   evictable (rebuild from `build[]`).

   Path selection is what makes capture usable — a naive full-home diff
   captures cache garbage and logs. Default path-sets per harness
   ("claude-code" → `~/.claude` + `~/.local/bin/claude`, …) live in
   `@atelier/compose` (content knowledge); the dev can add/remove paths.

   **Secret scrubbing is a design constraint on capture, not hygiene.**
   Harness config dirs are exactly where credentials live — `~/.claude`,
   `~/.config/pi`, opencode auth files hold API tokens, OAuth refresh
   tokens, machine identifiers. A captured artifact is arbitrary dev bytes
   pushed to a shared registry and materialized into other sandboxes: an
   unscrubbed capture is a credential-exfil path, not a bloat nit. The
   capture flow therefore ships with, from day one: (a) per-harness
   **exclude lists for known secret files** (part of the same compose-owned
   path-set defaults — `auth.json`, `credentials`, `.env*`, token caches);
   (b) a **content scan** over the delta before push (the usual
   secret-pattern scanners), failing the capture on findings unless
   explicitly overridden per file; (c) captured toolsets are
   **private-to-the-capturing-user by default** — sharing to the org is an
   explicit publish step. Secrets re-enter sandboxes through the front door
   only: spec `env`/`files[]` with `$secret` references, resolved by
   control at the seam.

2. **Built (input-keyed).** For reproducible org toolboxes: a build spec
   `{base, build[], paths[]}` executed the same way `prebuild()` executes
   today (throwaway pod, fail-fast steps — `runtime.service.ts:118`), except
   the output is *capture the path-sets → push artifact* instead of
   *snapshot the PVC*. Keyed `hash(base ⊕ build[] ⊕ paths)` — idempotent,
   deduped, evictable, exactly the existing prebuild economics.

Composition: a spec lists **multiple** toolsets; the agent materializes them
in order (later wins on conflicts, same rule as `files[]`). A dev typically
gets `org-toolbox ⊕ personal-toolset`; conflicts are rare because path-sets
are mostly disjoint by construction, and deterministic when not.

## 3. Spec and API changes

1. **`SandboxSpec` gains one field** (thinner than the earlier `mounts[]`;
   passes the §2 admission bar — "pull artifact, extract at paths" is
   `files[]`-grade mechanism, and maps 1:1 to how devcontainer Features are
   *consumed*):

   ```jsonc
   "toolsets": [
     { "ref": "toolset@sha256:3a9f…" },          // resolved refs only —
     { "ref": "toolset@sha256:7f3a…" }           // control resolves names,
   ]                                              // runtime sees hashes
   ```

   The runtime never sees "profile", "harness", or a toolset *name*.
   Control/compose resolve `alice's profile` → an ordered list of artifact
   hashes + the env fragments + config `files[]`. Env fragments from
   manifests are merged into the spec by compose, not by the runtime.

2. **Runtime API** (two endpoints, one verb each):

   ```
   POST /v1/toolsets                { base?, build[], paths[] } → { ref }   // built
   POST /v1/sandboxes/:id/toolsets/capture   { name, paths[] }  → { ref }   // captured
   ```

   Honest scoping: **the registry push path is new machinery.** The
   existing `ImageRegistryService` does HEAD manifest checks and digest
   resolution only (`registry/image-registry.service.ts`) — there is no
   upload path anywhere in the runtime. Publishing an OCI artifact means
   blob upload + manifest PUT (or shelling out to `oras`), plus zot-side
   config for a second artifact type (auth, GC/retention policy). Not hard,
   but it is a build item (§6), not free reuse. What *is* reused:
   `prebuild()` and its snapshot chaining stay exactly as they are — they
   remain the repo tier.

3. **Agent (v2 line)** gains one capability: given `toolsets[]`, pull each
   archive **directly from the in-cluster registry** and extract into the
   home **before** the files/env phase. No node-level cache in v1 — see the
   Kata note below. Phase order becomes:

   ```
   boot rootfs → toolsets materialize → files/env → postCreate → processes → postStart
   ```

   Materialize-before-files means org config packs can be overridden by
   spec-level `files[]` — the same last-wins layering compose already uses.

   **Why no node-level extract cache (yet): it fights the Kata boundary.**
   Each sandbox is a Kata microVM; the guest agent cannot see node-local
   disk. Sharing a per-node extracted cache into guests requires a virtio-fs
   host share or a privileged DaemonSet + shared volume — real perf/security
   design, and machinery the cluster does not have today. So v1's cold-path
   cost is stated plainly: **every materialize is a pull from in-cluster zot
   into the VM** — same-cluster network, zot's own storage caching, no
   internet round-trip; expected to be bandwidth-bound and acceptable for
   100s-of-MB artifacts. If telemetry says otherwise, the mitigations are,
   in order: the baked-pair cache (§5 rung 1, no new machinery), then a
   designed host-share cache (explicit follow-up spike, not an assumed
   freebie).

4. **`shared-binaries` dies.** The global RWO PVC + populate Job
   (`infra/k8s/v2/20-shared-binaries.yaml`, `kube.resources.ts:90`) is
   replaced by an org-published **toolbox artifact** (opencode + code-server
   as a built toolset). `catalogAdd` (`runtime.service.ts:496`) survives
   with its meaning upgraded: "publish checksum-verified artifact to the
   registry" instead of "cp onto the shared PVC". The `/opt/shared` mount
   and its PATH shim (`images/dev-base/Dockerfile:87`) go away with it.

## 4. Invalidation — the two flows the features demand

- **Repo push → repo rebuild, nobody's tools touched.** Repo prebuild key
  already includes repos (`hashPrebuild`, `runtime.service.ts:698`); make
  the *commit hash* explicit in the key: control resolves `branch → commit`
  at build time and records it, watches heads (webhook or poll — v1's
  staleness checker reborn in `control/`), and re-runs `prebuild()` on
  change. New key → new snapshot; old one GC-able when unreferenced.
  Toolset artifacts are unaffected by construction — they're not in the
  lineage.
- **Tools update → new toolset version, no repo rebuild.** `pi update --all`
  in any sandbox + `toolset capture` = new artifact hash; the dev's profile
  (a saved list in control) points at the new hash; next boot picks it up.
  Org toolbox bump = one artifact publish; every saved spec referencing the
  toolbox *name* gets the new hash at next enrichment. Repo snapshots are
  unaffected by construction.

The axes cannot invalidate each other because they are different object
types in different stores. That's the structural guarantee, not a policy.

## 5. Boot cost — a degradation ladder, not a cliff

Boot resolution, fastest first; every rung falls back to the next:

| Rung | What boots | Cost | When |
|---|---|---|---|
| **1. Baked pair** (optional cache) | snapshot keyed `hash(repoSnap ⊕ toolsetRefs)` — plain `prebuild()` chaining, built in background for hot combos | 1 CoW clone, ~instant | frequent (repo, profile) pairs |
| **2. Compose at boot** (the default) | repo snapshot clone + agent pulls toolsets from zot and extracts | clone + pull + seconds of copy | normal case |
| **3. No prebuilds at all** | image + `build[]`/`postCreate` hooks + `caches` warm volumes (`sandbox-spec.ts` `CacheSchema`) | minutes | brand-new repo/tool, evicted artifact |

Rung 1 resolves the "fully-baked is fastest but product-shaped" tension:
the **source of truth stays sum-shaped** (R snapshots + D artifacts); baked
pairs are a *derived cache*, keyed by their inputs, freely GC-able — evict
one and boot degrades to rung 2, never breaks. Control decides which pairs
are hot enough to bake; the runtime just sees another chained `prebuild()`.

Rung 2's cost is the honest price of this design: pulling from in-cluster
zot and extracting a few hundred MB into the home PVC is seconds, not
milliseconds — over the ~500ms overlay budget (`atelier-v2.md:260`),
mitigated by rung 1 for hot pairs. **Future optimization, explicitly out of
scope for v1 of this feature:** guest-side overlayfs (toolset archives as
read-only lowerdirs under the home upperdir — zero-copy, instant, stacks
natively). Same artifacts, same registry, same capture flow; only the
materialization step changes — ship copy-in first, measure, upgrade if boot
time actually hurts. (Overlay re-opens pause fidelity questions — lowers
aren't in the PVC — which is exactly why it waits.)

**Storage honesty: `O(repos + devs)` is the source-of-truth set, not the
materialized footprint.** Copy-in is what keeps pause/snapshot semantics
free (§1), and the flip side is that every live home PVC — and therefore
**every pause snapshot** — carries a full copy of its toolset bytes, so
pause snapshots fatten by roughly toolset size each. Still strictly better
than the chained matrix (warm/pinned *source* objects are R + D and the two
axes never invalidate each other), and the duplication is per-sandbox
transient state, not per-combination permanent state. The overlay
optimization above is also the fix for this, when it comes: lowers shared,
only the upper diff in the PVC.

## 6. Build plan — MVP first, hard-sequenced

The collective surface here is large: a new object type, a registry push
path, agent materialize + capture/diff, per-harness path-set defaults,
profile resolution, commit-keying/head-watching, an optional baked-pair
cache. Individually reasonable; shipped at once, a big bang. So the cut is
explicit:

**MVP — the load-bearing spine (built toolsets only):**

1. **Registry push path** (new machinery, named as such): OCI artifact
   upload — blob push + manifest PUT, or `oras` — plus zot config for the
   artifact type (auth, retention). `catalogAdd` re-targets to it.
2. **Spec: add `toolsets[]`** to `SandboxSpec`; wire into
   `specToAgentConfig` and the boot phase order. `caches` stays as-is (it's
   the rung-3 warm-cache tier, orthogonal).
3. **Agent: materialize.** Pull from zot, verify digest, extract into home
   paths before the files/env phase. v2 agent line only (`atelier-v2.md` §6
   phase 1); v1 untouched.
4. **Runtime: `POST /v1/toolsets` (built path only).** Reuses the prebuild
   executor scaffolding (throwaway pod, fail-fast, inflight dedup —
   `runtime.service.ts:79,118`) with an artifact-push tail instead of
   `snapshotPvc`.
5. **Kill `shared-binaries`:** publish opencode/code-server as the first
   built org toolbox; drop the PVC (a single RWO `local-path` claim —
   exactly the node-local liability this proposal removes), the populate
   Job, the pod mount, and the `/opt/shared` PATH shim.

This proves the whole spine — artifact type, push, resolve, materialize,
compose ordering — with only reproducible, reviewable toolsets, and
delivers a user-visible win (shared-binaries gone, org toolboxes real).

**Follow-ups, each gated on the MVP or on telemetry:**

6. **Capture** (`POST /v1/sandboxes/:id/toolsets/capture`): agent path-set
   diff + secret scrub (§2) + tar + push; per-harness path-set/exclude
   defaults in `@atelier/compose`; `atelier toolset capture|publish|list`;
   private-by-default sharing in control. The sexy demo — but it rides on
   the spine, not the other way around.
7. **Profiles in compose/control:** ordered toolset refs + env fragments +
   config files, resolved at enrichment; profile picker on spawn.
8. **Repo-tier commit keying** — not a footnote: this is the v1 staleness
   checker reborn in `control/` (webhook or poll head-watching, `branch →
   commit` recorded in the prebuild key, rebuild triggering, old-snapshot
   GC). Real control-plane work, independent of the toolset tier, can
   proceed in parallel.
9. **Baked-pair cache (rung 1)** when boot-time telemetry justifies it —
   pure `prebuild()` chaining plus a control-side policy.
10. **Perf spikes, only if measured:** host-share extract cache (the Kata
    design in §3), then guest overlayfs (§5).

## 7. Hard decisions (flagged, not hidden)

- **Captured toolsets are not reproducible.** Result-keyed by design; the
  price of the no-clicks capture UX. Mitigations: never silently GC'd,
  provenance recorded, and the input-keyed `build[]` path coexists for
  anything an org wants reproducible.
- **Conflicting toolsets.** Two toolsets touching the same path resolve
  last-wins in list order. Deterministic, but a foot-gun if org toolbox and
  personal toolset both ship e.g. `~/.config/opencode/config.json`.
  Compose should warn on manifest path-set overlap at spawn time.
- **Registry becomes availability-critical for boots** (rung 2). It
  already is for images; rung-1 baked pairs and rung-3 fallback bound the
  blast radius of an outage.
- **Pull + copy seconds at boot** (rung 2) until/unless overlay ships, and
  **toolset bytes duplicated into every home PVC and pause snapshot** (§5).
  Stated, measured, and short-circuited by rung 1 for hot pairs.
- **Capture trust boundary.** Beyond the secret-scrub constraint (§2): a
  captured artifact is arbitrary bytes a dev chose to publish, materialized
  into other sandboxes *only if their spec references it*. Same
  trusted-operator model as specs containing arbitrary shell
  (`atelier-v2.md` §7) — org toolboxes should prefer the built, reviewable
  `build[]` path, and captures are private-by-default.

## 8. Why this sells (long-term)

The toolset artifact is the one genuinely novel, ecosystem-shaped object in
the system — "**your agent setup is a versioned, portable artifact**".
devcontainer Features exist for project tooling; nothing exists for
*personal agent harness* tooling (claude-code + MCPs + skills + pi plugins).
Every target persona lands on it:

- **Dev:** try a new MCP in a throwaway sandbox, `toolset capture`, it's now
  part of your profile on every future boot — two commands.
- **Org:** publish "company toolbox v12" once; every sandbox picks it up at
  next boot; no repo prebuild touched, no dev toolchain overridden.
- **Non-tech user:** repo ⊕ org toolbox ⊕ vscode preset = one saved spec,
  one tap.

And it aligns with §8 of `atelier-v2.md`: specs stay portable JSON (no
lock-in, easy adoption); the org's toolbox library and devs' captured
toolsets become the retention gravity — above the seam, where gravity is
supposed to live. A hosted product later is control-plane + hosted toolset
registry over the same open runtime.

## 9. Bottom line

Two tiers, two mechanisms, matched to their physics: **repos stay
content-addressed VolumeSnapshots** (big, node-local, commit-keyed);
**toolsets become registry artifacts materialized by the agent** (small,
any-node, dev- or org-keyed). Storage and invalidation go from
`O(repos × devs)` entangled to `O(repos + devs)` independent; per-dev
toolchain freedom costs one artifact per dev instead of one snapshot lineage
per (dev, repo); and boot speed is a cache-hit gradient (baked pair →
composed → cold pull → build from scratch), never a capability cliff.
