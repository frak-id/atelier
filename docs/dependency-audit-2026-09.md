# Dependency Audit — Atelier v3.0.2

**Date:** 2026-09-11
**Scope:** 7 npm workspaces (root, `apps/server`, `apps/cli`, `apps/console`, `packages/{spec,compose,shared}`) + the Rust crate `apps/agent-v2`.
**Method:** direct deps extracted from each manifest, resolved versions from `bun.lock` / `Cargo.lock`, compared against the npm registry and crates.io live. Changelogs read from upstream sources; advisory range confirmed against the OSV API.

---

## 0. Execution record — applied 2026-09-11

Batches 1–4 were applied, **except `lucide-react`** (held back at `^0.468.0` by request)
and the Rust crate (see below). A Bun **version catalog** was also introduced.

**Verified green after every batch:** `bun run typecheck` (6/6 workspaces), `bun run lint`,
`apps/cli` build, `apps/console` build, `apps/server` build, `atelier --version` smoke test,
and a from-scratch `bun install --frozen-lockfile`.

| Item | Result |
|---|---|
| Batch 1 — 31 minors/patches | ✅ applied |
| Batch 2 — esbuild `^0.24.0` → `^0.28.2` + override | ✅ applied; tree collapsed **4 esbuild versions → 1**, advisory closed |
| Batch 3 — commander 15, @clack/prompts 1.8, nanoid 6, knip 6.35 | ✅ applied (lucide-react excluded) |
| Batch 4 — TypeScript 7 + drop `@typescript/native-preview` | ✅ applied; `tsgo` → `tsc`, typecheck 5.7s, zero errors |
| Batch 4 — `@opencode-ai/sdk` 1.16.2 → 1.18.30 | ✅ applied (exact-pin style preserved) |
| Batch 4 — `tokio-tungstenite` 0.24 → 0.30 | ⛔ **not applied** — no Rust toolchain available (see §7) |
| Bun version catalog | ✅ added for the 4 deps shared by 2+ workspaces |

**Three changes required code edits, not just version bumps:**

1. **`@clack/prompts` 1.x widened `validate`** to `(value: string \| undefined) => MaybePromise<string \| Error \| undefined>`.
   Fixed with a single `adaptValidate()` helper at the `apps/cli/src/ui.ts` wrapper boundary,
   so all 8 call sites were left untouched.
2. **Biome 2.5.13 flagged 2 new `useOptionalChain` warnings** (2.4.12 was clean). Applied Biome's own
   fix — `!x || x.p !== v` → `x?.p !== v`, provably equivalent — in `jobs.service.ts` and `image-builder.service.ts`.
3. **`@tanstack/router-plugin` 1.168 regenerated `routeTree.gen.ts`.** Verified as a pure import
   reordering (174 ins / 174 del, byte-identical when sorted) — no behavioural change.

**Tree hygiene:** duplicated packages 51 → 43; `esbuild` 4 → 1 (dropping ~66 redundant platform
binaries); all Radix duplicates collapsed; total install 399 → 372 packages.

**Not verified in this environment:** `bun run knip` now crashes here, but *not* because of the
upgrade's logic — knip 6.35 parses via `oxc-parser`, which reserves a **6 GiB** `ArrayBuffer`
while this sandbox is capped at a **4 GiB** cgroup. It should run fine on a normal dev machine or
a 16 GB CI runner. knip is **not** in CI, so nothing is blocked. Flagging it as unverified rather
than claiming it passes.

---

## 1. Health snapshot

| Gap | Count | Notes |
|---|---|---|
| **Major behind** | 5 | `typescript`, `commander`, `nanoid`, `@clack/prompts`, `lucide-react` |
| **Minor behind** | 22 | incl. `esbuild` (0.x ⇒ effectively breaking), `knip`, `@opencode-ai/sdk` |
| **Patch behind** | 12 | incl. `jose` (JWT/crypto) |
| **Current** | 18 | |

Rust (`apps/agent-v2`): healthy. All crates within caret range of latest **except `tokio-tungstenite` 0.24 → 0.30**.

Overall: **the estimate is "moderately behind, with one strategic decision and one hygiene problem"** — not a neglected tree. Most of `apps/server` is current or near-current.

---

## 2. Findings by priority

### 🔴 P0 — `esbuild` ^0.24.0 → ^0.28.2 (security + hygiene)

**Why.** `esbuild < 0.25.0` is affected by **GHSA-67mh-4wv8-2f99** (CVSS 3.1 `AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:N/A:N`, moderate). Confirmed affected range via OSV: `introduced: 0, fixed: 0.25.0`. Two vulnerable copies are in the tree:

- `esbuild@0.24.2` — direct devDependency of `apps/cli`
- `esbuild@0.18.20` — transitive, via `drizzle-kit → @esbuild-kit/esm-loader → @esbuild-kit/core-utils`

**Real-world exposure: effectively nil.** The advisory is *dev-server only*. `apps/cli/build.mjs` uses the `build()` API and never calls `serve()`. So this is a **scanner-hygiene and supply-chain-posture fix, not an incident.** Worth doing, not worth panicking over.

**Side effects — assessed as low.** I checked each documented breaking change from 0.25/0.27/0.28 against actual usage in `build.mjs`:

| Breaking change | Affects us? |
|---|---|
| 0.25 dev server CORS + `serve()` returns `hosts[]` | ❌ `serve()` not used |
| 0.25 watch mode deletes output on failure | ❌ watch not used |
| 0.25 source-map paths now URLs | ❌ no sourcemaps |
| 0.25 BigInt → `BigInt()` when unsupported | ❌ `target: node20` supports it |
| 0.25 `--drop:console` semantics | ❌ not used |
| 0.27 `binary` loader needs `target` | ❌ binary loader not used |
| 0.27 Go 1.25 raises OS floor (Linux ≥3.2, macOS ≥12) | ❌ CI is `oven-sh/setup-bun` on GH runners |
| **0.27.5 TS parameter properties use define semantics** | ⚠️ see below |
| 0.28 install-script integrity check on fallback download | ✅ *benefit* — supply-chain hardening |

⚠️ **The one item I checked carefully:** parameter properties (`constructor(private readonly x: T)`) change emit semantics in 0.27.5+. There are **10 usages, and all 10 are in `apps/server`** — which is bundled by **Bun**, not esbuild. `apps/cli` (the only esbuild consumer) has none. **No impact.**

**Benefit.** Closes the advisory; `with { type: 'text' }` import support (0.28); binary-integrity verification on install.

**Also fix the transitive 0.18.20.** `@esbuild-kit/esm-loader` and `@esbuild-kit/core-utils` are both **deprecated upstream** ("Merged into tsx"). They arrive via `drizzle-kit`. Pin with a Bun override until `drizzle-kit` drops them:

```jsonc
"overrides": { "esbuild": "^0.28.2" }
```

---

### 🟠 P1 — TypeScript 6 → 7, and retire `@typescript/native-preview`

**This is the most valuable change available, and the migration cost here is unusually low.**

**Context.** TypeScript **7.0.2 shipped 2026-08-20**. TS 7 *is* the native Go port — the GitHub release for `v7.0.2` points at the `typescript-go` repo. This project **already runs the native compiler**: every workspace's `typecheck` script is `tsgo --noEmit`, via `@typescript/native-preview` (^7.0.0-dev.20260415.1, resolved to `7.0.0-dev.20260707.2`).

**The problem: you're on a dead channel.** `@typescript/native-preview`'s last publish was **2026-07-07**. Per the 7.0 announcement, nightlies "will soon resume under the standard `typescript` package with the `next` tag". The preview package has served its purpose. You're pinned to a pre-GA dev build of a compiler that has since gone stable.

**Migration friction: LOW.** TS 7 removes a lot, but I checked your tsconfigs against every removal and **you already comply**:

| TS 7 removal / new default | Your config | Status |
|---|---|---|
| `moduleResolution: node/node10` removed | `"bundler"` everywhere | ✅ |
| `target: es5` removed | `ESNext` / `ES2022` | ✅ |
| `baseUrl` removed | not used (console's `paths` already relative) | ✅ |
| `module: amd/umd/systemjs/none` removed | `Preserve` / `ESNext` (both supported) | ✅ |
| `downlevelIteration` removed | not used | ✅ |
| `esModuleInterop`/`alwaysStrict` can't be `false` | not set | ✅ |
| new default `strict: true` | already `true` | ✅ |
| new default `stableTypeOrdering: true` (forced) | n/a | ✅ |
| **new default `types: []`** | root sets `["bun"]`, cli `["node"]`; **console sets none** | ⚠️ verify console |
| **new default `noUncheckedSideEffectImports: true`** | console sets it; root does not | ⚠️ may surface new errors in server/cli/packages |
| `rootDir` defaults to `./` | set explicitly in all but console (which is `noEmit`) | ✅ |

**Two blockers that do *not* apply to you:**
- *Embedded-language tooling* (Vue/Svelte/Astro/Angular/Volar) must stay on TS 6 — you're **React**, unaffected.
- *typescript-eslint* needs the TS 6 API — you use **Biome**, unaffected.

**Caveat checked and cleared.** TS 7.0 ships no compiler API (a new one lands in 7.1), so any code importing `typescript` programmatically would need the `@typescript/typescript6` compat package. I grepped the repo: **there are no `from "typescript"` / `require("typescript")` imports anywhere outside `node_modules`**. `scripts/` contains only `bump-version.ts` and `deploy-k8s.sh`. This blocker does not apply.

**Benefit.** Officially measured **8–12x** faster full builds (vscode 125.7s → 10.6s), 6–26% lower memory, >13x faster first-error in-editor, language-server crashes down >60%. New `--checkers N` parallelism flag. And you delete a dependency and collapse `tsgo` → plain `tsc`.

**Note:** `typescript` currently sits in the root `peerDependencies` *and* `overrides` — unusual for a private root package. Worth cleaning up in the same pass.

---

### 🟡 P2 — Genuinely stale, worth scheduling

| Package | Current | Latest | Comment |
|---|---|---|---|
| **`lucide-react`** | 0.468.0 (**pub. 2024-12-05**) | 1.44.0 | **~21 months stale — the single worst gap.** 0.x→1.0 (2026-03-23) was primarily a stabilisation/versioning milestone. Icon libs are low-risk: worst case is renamed icons, caught at typecheck. |
| **`knip`** | 6.4.1 | 6.35.1 | 31 minors behind. Dev-only; risk is limited to new/changed unused-code reports (may need `knip.json` tuning). |
| **`@opencode-ai/sdk`** | **1.16.2 (exact pin)** | 1.18.30 | Only exact-pinned dep in the repo — presumably deliberate, given it's the harness SDK. **Needs an owner decision**, not an automatic bump. |
| **`@agentclientprotocol/sdk`** | 1.1.0 | 1.4.0 | ACP protocol lib backing the agent bridge — 3 minors of protocol surface you may want. |
| **`tokio-tungstenite`** (Rust) | 0.24.0 | 0.30.0 | 6 breaking 0.x releases. Notables: 0.28 shrinks `Error` 136→32 bytes; 0.29 allows non-visible-ASCII header values; 0.30 rejects malformed `Sec-WebSocket-Key` and **raises MSRV to 1.85**. Check the `rust:1-alpine` builder satisfies MSRV. |

---

### 🟢 P3 — Low-risk routine updates

**Safe majors** (all clear for this repo):
- **`commander` 14 → 15** — ESM-only. Every manifest is `"type": "module"`; the CLI bundles ESM. Seamless. (TS 14 maintenance ends May 2027.)
- **`@clack/prompts` 0.11 → 1.x** — ESM-only, explicitly "prioritised stability over large breaking changes". New: `showInstructions` on `select`/`multiselect`, autocomplete filter hooks.
- **`nanoid` 5 → 6** — ~4x faster `nanoid()`/`customAlphabet()`. Drops Node 18/20 — **not a problem**: it's used only in `apps/server`, which runs on Bun. (Note `apps/cli` declares `engines.node >= 20` but does not use nanoid.)

**Patches worth taking promptly:**
- **`jose` 6.2.2 → 6.2.12** — JWT/crypto library, 10 patches behind. Prioritise this one.
- `elysia` 1.4.28 → 1.4.30, `ws` → 8.21.3, `sonner` → 2.0.8, Radix `*` patches, `@sinclair/typebox` → 0.34.52.

**Routine minors:** `react`/`react-dom` 19.2.5 → 19.3.0, `vite` 8.0.8 → 8.3.0, `tailwindcss` + `@tailwindcss/vite` 4.2.2 → 4.3.3, `zod` 4.3.6 → 4.6.1, `@biomejs/biome` 2.4.12 → 2.5.13, TanStack router/query, `@types/bun` → 1.4.2.

**⚠️ Do NOT take:** `elysia@2.0.0-beta.14` exists on the `next` tag. Stay on 1.4.x; plan for 2.0 separately once stable.

---

## 3. Tree hygiene

**51 packages are duplicated in the lockfile.** Worst offenders:

- **`esbuild` ×4** — 0.18.20, 0.24.2, 0.25.12, 0.27.7 (each dragging ~22 platform binaries → real install-size cost). Sources: direct (0.24.2), `drizzle-kit` (0.25.12), `tsx` (0.27.7), deprecated `@esbuild-kit/core-utils` (0.18.20).
- **`@types/node` ×3** — 18.19.130, 22.20.1, 25.6.0 (and `undici-types` ×3 alongside). `apps/cli` pins `^22.10.0` while `engines.node >= 20`.
- **`zod` ×2** — 3.25.76 + 4.3.6.
- Radix internals ×2–3 across ~14 packages — will collapse on their own once the Radix patches land.

**Inconsistency:** `vite@8.0.8` declares optional peer `esbuild: ^0.27.0 || ^0.28.0`, but the tree resolves `vite/esbuild` to **0.25.12** — outside the declared range. A single top-level `esbuild` override fixes this *and* the duplication *and* the advisory in one move.

---

## 4. Audit capability gap

`bun audit` **cannot run in this environment**:

```
error: POST http://verdaccio.verdaccio.svc.cluster.local:4873/-/npm/v1/security/advisories/bulk - 404
```

The private Verdaccio registry doesn't implement the bulk-advisories endpoint. **You currently have no automated vulnerability scanning** — the esbuild advisory above was found by manual OSV lookup, not by tooling. Recommend either pointing audit at the public registry in CI, or adding an OSV/Dependabot/`osv-scanner` step. **This is arguably a more important finding than any single version bump.**

---

## 5. Suggested sequencing

**Batch 1 — low risk, do now**
`jose`, `elysia`, `ws`, `sonner`, Radix, TypeBox, `@types/*`, `biome`, `react`/`react-dom`, `vite`, `tailwind`, `zod`, TanStack.
→ One `bun update`, run `typecheck` + `check` + CI.

**Batch 2 — esbuild + hygiene**
Bump `esbuild` to `^0.28.2` in `apps/cli`, add the top-level override, rebuild the CLI, diff the bundle, smoke-test `atelier --version`.

**Batch 3 — safe majors**
`commander` 15, `@clack/prompts` 1.x, `nanoid` 6, `lucide-react` 1.x (typecheck catches renamed icons), `knip` (expect config tuning).

**Batch 4 — strategic, own PR each**
- TypeScript 7 + drop `@typescript/native-preview` (TS-API usage already verified absent; add `noUncheckedSideEffectImports` + explicit `types` to root/console preemptively).
- `tokio-tungstenite` 0.30 (verify MSRV 1.85 in the Alpine builder).
- `@opencode-ai/sdk` — decision required on the exact pin.

**Batch 5 — CI**
Restore vulnerability scanning.

---

## 6. Caveats on this report

- Changelog detail is sourced from upstream (esbuild `CHANGELOG.md`/`CHANGELOG-2025.md`, the TypeScript 7.0 announcement, tokio-tungstenite/tungstenite changelogs, npm registry metadata, OSV API). I did **not** find a reliable changelog for `lucide-react` 1.0 or `knip` 6.x — those two recommendations rest on version-gap and release-date evidence, not on read release notes. Treat their "what's new" as unverified.
- Sections 1–5 below describe the state **as audited, before any changes**. See §0 for what was actually applied, and §7 for the remaining follow-ups.
- Version data is a point-in-time snapshot (2026-09-11); several of these packages publish weekly.

---

## 7. Remaining follow-ups

### 7.1 `tokio-tungstenite` 0.24 → 0.30 — deferred, needs code changes

**Not applied: there is no Rust toolchain in this environment** (`cargo` is not installed), so the
upgrade could not be compiled or tested. Bumping 6 breaking releases blind would have been reckless.

It is **not** a drop-in bump. `apps/agent-v2/src/terminal.rs` and `src/attach.rs` call:

```rust
sink.send(Message::Binary(chunk.to_vec())).await
```

`tungstenite` 0.26 changed `Message::Binary` to take `Bytes` rather than `Vec<u8>` (and `Message::Text`
to take a `Utf8Bytes`), so those call sites need updating. Other notables across the range:
0.28 shrinks `Error` from 136 → 32 bytes (boxed internals), 0.29 permits non-visible-ASCII header
values, 0.30 rejects malformed `Sec-WebSocket-Key` and **raises MSRV to 1.85** — confirm the
`rust:1-alpine` builder in `apps/agent-v2/Dockerfile` satisfies that.

All other crates are within caret range of latest and will move on a routine `cargo update`.

### 7.2 `lucide-react` — held at `^0.468.0` by request

Still the single stalest dependency (published 2024-12-05, ~21 months old); 1.44.0 is current.
Revisit when convenient — typecheck will catch any renamed icons.

### 7.3 Restore vulnerability scanning (unchanged, still open)

`bun audit` still cannot run against the private Verdaccio registry (404 on the bulk-advisories
endpoint). The esbuild advisory closed in Batch 2 was found by manual OSV lookup. Add an
`osv-scanner` / Dependabot step, or point audit at the public registry in CI.

### 7.4 Optional cleanup

`typescript` sits in the root `peerDependencies` *and* `overrides`. A `peerDependencies` entry on a
private root package achieves nothing; it was updated to `^7.0.2` for consistency but could simply
be dropped.

### 7.5 Note on `@types/node`

Left on `^22.20.2` rather than moved to 25.x. `apps/cli` declares `engines.node >= 20`, and typing
against a newer Node than the minimum supported runtime is the dangerous direction — it lets code
use APIs absent at runtime. Staying on 22 is deliberate.
