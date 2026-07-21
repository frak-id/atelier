# v1 Decommission — Findings (packages/shared audit + image-build model)

Companion to `v1-decommission.md`. That doc lists the deployables to delete;
this one records what was found auditing the **shared package** (does v2 really
still need it?) and the **image-build model** (why v2 doesn't touch the v1
`imageBuilder` config). Nothing here is deleted yet — these are flags.

Namespace tell: `@frak/*` = v1 lineage, `@atelier/*` = v2. But `@frak/atelier-shared`
is a special case (see below) — namespace is NOT a reliable v1 signal for it.

## 1. `packages/shared` (`@frak/atelier-shared`) — KEEP, but trim

Verdict: **keep the package** — v2 genuinely depends on it — but it carries
v1-only files/fields that die with `apps/manager`.

### Exports and who consumes them

| Export | v2 uses it? | Notes |
|--------|-------------|-------|
| `./constants` (`infra.ts`, `vm-config.ts`) | ✅ server, acp surface | `VM` constants. Shared. |
| `.` → `config.schema` + `config.loader` | ✅ server (`loadConfig`, `validateConfig`) | Deployment/infra config. Shared, but v1-shaped (see §2). |
| `.` → `agent.schema` | ✅ server + console | ACP `AgentSession`/`AgentEvent`/`AgentTodo`/`AgentPermission*`. Shared. |
| `.` → `image-discovery` | (unverified) | check before trusting. |
| `./sandbox-config` + `./sandbox-config-loader` | ❌ **v1-only** | see §3. |

Import-site counts today: v1 (manager 23 + dashboard 14 = 37) vs v2 (server 8 +
console 6 = 14, plus `packages/compose` declares the dep). The raw count skews
v1 only because v1 has more files and is about to be deleted — the 14 v2 sites
are real.

## 2. `config.schema.ts` — shared infra config, still v1-worded

v2's server reuses the v1 "unified config" schema **verbatim** via `loadConfig()`
/ `validateConfig()`. It is legitimately reused because it is the
**deployment/infra contract** (same cluster: Kata runtimeClass, Zot registry,
GitHub OAuth, wildcard domain, tool ports) — not application logic. v2 runs a
new app on the same cluster wiring.

Fields v2 actually reads (verified by grep of `config.*` access in `apps/server`):
`auth.*`, `domain.*`, most of `kubernetes.*` (namespace, runtimeClass,
registryUrl, storageClass, volumeSnapshotClass, ingress annotations…),
`ports.*` (vscode/opencode/browser/terminal/agent/dev), `sandbox.defaultImage`,
`server.*`, `integrations.cliproxy`.

v1 cruft riding along (flag for trim, not urgent):
- **Stale wording** — "Manager API port/host/settings", `managerUrl` doc comment
  "Internal base URL of the **manager** K8s Service", `ports.acp` comment
  "see agent-rust/acp.rs".
- **Fields v2 never reads:** `kubernetes.managerUrl`, `server.maxSandboxes`,
  `ports.acp`, `ports.devApp`, `sandbox.imagesDirectory`.
- Their matching `ENV_VAR_MAPPING` entries (e.g. `ATELIER_K8S_MANAGER_URL`,
  `ATELIER_MAX_SANDBOXES`).

**KEEP `imageBuilder.*` (+ its 7 `ATELIER_IMAGE_BUILDER_*` env maps).** It is
currently unread by v2 (see §4) but is **intentionally retained**: server-side
base-image build is planned to be re-introduced into `apps/server`, at which
point the server will consume `imageBuilder.*` again. Do not trim it. Only the
v1 *implementation* (`apps/manager/src/infrastructure/image-builder/`) dies with
manager — the config seam stays.

Two cleanup options once manager dies:
1. **Minimal** — leave `config.schema` in shared, delete v1-only fields + fix
   "Manager" wording.
2. **Proper** — move config into `apps/server` (v2 owns its config), trimmed to
   what it reads; `packages/shared` shrinks to `constants` + `agent.schema`.

## 3. `sandbox-config.schema.ts` — v1-only, delete with manager

`SandboxConfig` (the old ConfigMap projection the manager wrote into the pod) is
imported **only** by `apps/manager` (+ one stale comment in `opencode-atelier`).
v2 replaced the concept wholesale with **`packages/spec` (`SandboxSpec`)** plus
`apps/server/src/runtime/agent-config.ts` (whose own comment says it "mirrors
v1's lossy `specToSandboxConfig`"). Deletable:
- `packages/shared/src/sandbox-config.schema.ts`
- `packages/shared/src/sandbox-config.loader.ts`
- the `./sandbox-config` and `./sandbox-config-loader` entries in the package's
  `exports`.

## 4. Why v2 does NOT use `imageBuilder` (kaniko/buildkit)

Not a missing feature — v2 **replaced the whole "build an OCI image with a
kaniko/buildkit Job driven by the manager at runtime" model** with three
distinct mechanisms, none of which read `imageBuilder.*` config:

1. **Prebuilds → CSI VolumeSnapshots.** `runtime.service.ts` `prebuild()` /
   `executePrebuild()` boot a sandbox, run hooks, then `buildVolumeSnapshot` the
   PVC. Content-addressed by hash, chained, idempotent, instant clone. No image
   layers, no build Job. (See `composed-prebuild-volumes.md`.)
2. **Toolboxes / toolsets → in-pod agent build.** `runtime.service.ts`
   `buildToolset()` / `captureToolset()` delegate to the **guest agent**
   (`agent.buildToolset(tempId, …)`), which produces a content-addressed
   artifact `toolsets/{name}@{digest}` pushed to Zot, deduped by content hash.
   Built inside a throwaway sandbox pod — not a kaniko Job, no Dockerfile, no
   `imageBuilder` strategy.
3. **Base images (dev-base-v2, dev-cloud) → deploy-time buildctl.**
   `infra/k8s/v2/deploy.sh` runs `buildctl` against a **shared buildkitd**
   (`tcp://buildkitd.buildkit.svc:1234`) from a builder pod. The endpoint is
   hardcoded in the script, not read from config. The **server never builds base
   images** — `runtime/registry/image-registry.service.ts` only does a HEAD
   manifest check (`imageExists`) and errors "IMAGE_NOT_AVAILABLE" if missing.
   (Its "Build it from the Images page" message is aspirational/leftover; there
   is no image-build route in the v2 server API.)

Consequence: today the v1 `imageBuilder.*` config section + its 7
`ATELIER_IMAGE_BUILDER_*` env vars are unread by v2. **But do NOT trim them** —
server-side base-image build is planned to return to `apps/server`, and it will
consume this same config seam. Keep the schema; only the v1 kaniko/buildkit
*implementation* in `apps/manager/src/infrastructure/image-builder/` dies with
manager (and is a useful reference when re-implementing on the server).

## 5. Blocker not in the original checklist: `packages/opencode-atelier`

The npm-published plugin still type-imports v1 manager:
- `src/client.ts` → `import type { App } from "@frak/atelier-manager"`
- `src/types.ts` → `export type { Sandbox } from "@frak/atelier-manager/types"`
- workspace dep in its `package.json`

It will fail typecheck/build the moment `apps/manager` is deleted. **Migrate it
to `@atelier/server` / `@atelier/cli` types (or retire it) before deleting
manager.** This is the one item `v1-decommission.md` §1 misses.

## Summary of flags

| Item | Action | Blocker before? |
|------|--------|-----------------|
| `apps/manager`, `apps/dashboard`, `apps/agent-rust` | delete | zero live v1 sandboxes; console replaces dashboard |
| `packages/opencode-atelier` manager import | migrate/retire | **must precede manager delete** |
| `shared/sandbox-config.{schema,loader}.ts` + exports | delete | manager delete |
| `config.schema` v1 fields (`managerUrl`, `maxSandboxes`, `ports.acp/devApp`, `sandbox.imagesDirectory`) + env maps | trim | manager delete |
| `config.schema` `imageBuilder.*` (+ env maps) | **KEEP** — planned server-side base-image build | — |
| `config.schema` "Manager" wording | relabel | — |
| `packages/shared` (constants, config, agent.schema) | **keep** | — |
