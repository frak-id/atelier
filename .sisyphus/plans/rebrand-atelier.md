# Rebrand: Frak Sandbox → L'atelier

## TL;DR

> **Quick Summary**: Rebrand the entire Bun monorepo from "Frak Sandbox" to "L'atelier". Purely mechanical renaming across ~55 files — no logic changes, no refactoring. Covers NPM packages, TypeScript types, env vars, system paths, systemd services, Docker images, CLI binary, dashboard UI, infrastructure scripts, CI/CD, and documentation.
>
> **Deliverables**:
> - All `@frak-sandbox/*` packages renamed to `@frak/atelier-*`
> - All `FRAK_*` env vars renamed to `ATELIER_*`
> - All `/opt/frak-sandbox` and `/etc/frak-sandbox` paths → `/opt/atelier` and `/etc/atelier`
> - CLI binary renamed from `frak-sandbox` to `atelier`
> - Systemd service files renamed and updated
> - Docker images renamed from `frak-sandbox/*` to `atelier/*`
> - Dashboard UI branding updated to "L'atelier"
> - All documentation updated
> - `bun install`, `bun run typecheck`, `bun run check` pass clean
>
> **Estimated Effort**: Medium (mechanical but touches many files)
> **Parallel Execution**: YES — 5 waves
> **Critical Path**: Task 1 (shared pkg) → Task 2 (packages) → Task 8 (verification)

---

## Context

### Original Request
Rebrand the project from "Frak Sandbox" to "L'atelier" across all code, configuration, infrastructure, and documentation files.

### Interview Summary
**Key Discussions**:
- Display name: "L'atelier" (capital L, lowercase a)
- Technical name: "atelier" (CLI binary, paths, env vars)
- "sandbox" stays as a concept (DB tables, variable names, API paths, sandbox-agent)
- `@frak` npm org scope stays — packages become `@frak/atelier-*`
- `sandbox.config.json` filename stays
- VM internal paths (`/etc/sandbox/`, `/var/lib/sandbox/`) stay
- `sandbox@frak.dev` git email: keep for now (TBD)
- GitHub repo URLs (`frak-id/oc-sandbox`): keep as-is (repo rename is separate)
- No tests in project — verification via typecheck + lint only

### Metis Review
**Identified Gaps** (addressed):
- Registry cache name `frak-registry-cache` → `atelier-registry-cache` (added to Task 4)
- Missing env var renames: `FRAK_RELEASE_REPO`, `FRAK_RELEASE_BASE_URL`, `FRAK_CONFIG` (added to Task 3)
- `pkill -9 frak-sandbox` in deploy.ts (added to Task 5)
- Tarball names in release.yml need updating (added to Task 6)
- Case convention standardized: "L'atelier" (display), "atelier" (technical)

---

## Work Objectives

### Core Objective
Replace all "Frak Sandbox" branding with "L'atelier" / "atelier" across the entire codebase while preserving "sandbox" as a domain concept.

### Concrete Deliverables
- 5 updated package.json files
- 3 updated shared library files (config.schema.ts, config.loader.ts, constants.ts)
- 12+ updated CLI source files
- 4+ updated Manager source files
- 5+ updated Dashboard source files
- 2 renamed + updated systemd service files
- 7 updated infrastructure files (Dockerfiles, scripts, Caddyfile)
- 2 updated CI/deployment files
- 10+ updated documentation files
- Clean build verification

### Definition of Done
- [ ] `grep -rn "frak-sandbox" --include="*.ts" --include="*.tsx" --include="*.json" --include="*.sh" --include="*.yml" --include="*.service" . | grep -v node_modules | grep -v bun.lock | grep -v .sisyphus` returns 0 results
- [ ] `grep -rn "@frak-sandbox/" . | grep -v node_modules | grep -v bun.lock` returns 0 results
- [ ] `grep -rn "FRAK_" --include="*.ts" . | grep -v node_modules` returns 0 results
- [ ] `grep -rn "/opt/frak-sandbox" . | grep -v node_modules | grep -v bun.lock | grep -v .sisyphus` returns 0 results
- [ ] `grep -rn "/etc/frak-sandbox" . | grep -v node_modules | grep -v bun.lock | grep -v .sisyphus` returns 0 results
- [ ] `bun install` succeeds
- [ ] `bun run typecheck` exits 0
- [ ] `bun run check` exits 0

### Must Have
- All renaming rules applied consistently
- "sandbox" as concept preserved (DB tables, variable names, API paths, sandbox-agent crate)
- Clean builds for all packages

### Must NOT Have (Guardrails)
- Do NOT change GitHub repository URLs (`frak-id/oc-sandbox`) — repo rename is separate scope
- Do NOT change `allowedOrg: "frak-id"` in config — this is the actual GitHub org
- Do NOT change email addresses (`@frak.id`, `@frak.dev`, `sandbox@frak.dev`) — TBD
- Do NOT change actual configuration values in `sandbox.config.json` or `sandbox.config.example.json`
- Do NOT edit `bun.lock` manually — it regenerates via `bun install`
- Do NOT touch `routeTree.gen.ts` — TanStack Router auto-generates it
- Do NOT change Cargo.toml or any Rust code — `sandbox-agent` crate stays as-is
- Do NOT change database schema, migration files, or SQL
- Do NOT rename the `sandbox.config.json` / `sandbox.config.example.json` filenames
- Do NOT change VM-internal paths: `/etc/sandbox/`, `/var/lib/sandbox/`, `/var/log/sandbox/`
- Do NOT refactor, improve, or restructure any code — mechanical rename ONLY
- Do NOT add documentation, tests, or comments beyond what exists

---

## Naming Convention Reference

| Context | Old | New |
|---------|-----|-----|
| Display name (UI, docs) | "Frak Sandbox" | "L'atelier" |
| Technical name (paths, binary) | `frak-sandbox` | `atelier` |
| NPM package prefix | `@frak-sandbox/` | `@frak/atelier-` |
| Root package name | `oc-sandbox` | `atelier` |
| Config type name | `FrakConfig` | `AtelierConfig` |
| Config schema name | `FrakConfigSchema` | `AtelierConfigSchema` |
| Config variable name | `frakConfig` | `atelierConfig` |
| Env var prefix | `FRAK_` | `ATELIER_` |
| System user/group | `frak` | `atelier` |
| Docker image prefix | `frak-sandbox/` | `atelier/` |
| Systemd service prefix | `frak-sandbox-` | `atelier-` |
| localStorage key prefix | `frak_` | `atelier_` |
| SSH host alias | `frak-sandbox` | `atelier` |
| App directory | `/opt/frak-sandbox` | `/opt/atelier` |
| Config directory | `/etc/frak-sandbox` | `/etc/atelier` |
| VM app directory | `/.frak-sandbox/` | `/.atelier/` |

---

## Verification Strategy (MANDATORY)

> **UNIVERSAL RULE: ZERO HUMAN INTERVENTION**
>
> ALL tasks in this plan MUST be verifiable WITHOUT any human action.

### Test Decision
- **Infrastructure exists**: NO
- **Automated tests**: None
- **Framework**: none

### Agent-Executed QA Scenarios (MANDATORY — ALL tasks)

Every task includes grep-based content verification plus build commands.
Final verification task runs comprehensive grep + build + lint checks.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately):
├── Task 1: Shared package (foundation — types, constants, config)
└── Task 6: Infrastructure files (systemd, Dockerfiles, scripts — independent)

Wave 2 (After Wave 1):
├── Task 2: Package configs (package.json files — depends on shared types)
├── Task 3: CLI source files (depends on shared package)
├── Task 4: Manager source files (depends on shared package)
└── Task 5: Deploy + CI (depends on systemd file renames from Task 6)

Wave 3 (After Wave 2):
└── Task 7: Dashboard source files (depends on package renames from Task 2)

Wave 4 (After Wave 3):
└── Task 8: Documentation (depends on all code changes being final)

Wave 5 (After Wave 4):
└── Task 9: Final verification + bun install (depends on everything)

Critical Path: Task 1 → Task 2 → Task 7 → Task 8 → Task 9
Parallel Speedup: ~50% faster than sequential
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|------------|--------|---------------------|
| 1 | None | 2, 3, 4 | 6 |
| 2 | 1 | 7, 9 | 3, 4, 5 |
| 3 | 1 | 8, 9 | 2, 4, 5, 6 |
| 4 | 1 | 8, 9 | 2, 3, 5, 6 |
| 5 | 6 | 8, 9 | 2, 3, 4 |
| 6 | None | 5 | 1 |
| 7 | 2 | 8, 9 | None |
| 8 | 3, 4, 5, 7 | 9 | None |
| 9 | ALL | None | None (final) |

### Agent Dispatch Summary

| Wave | Tasks | Recommended Agents |
|------|-------|-------------------|
| 1 | 1, 6 | Two parallel `quick` tasks |
| 2 | 2, 3, 4, 5 | Four parallel `quick` tasks |
| 3 | 7 | One `quick` task |
| 4 | 8 | One `quick` task |
| 5 | 9 | One `quick` task (verification) |

---

## TODOs

- [ ] 1. Rename shared package internals (types, config schema, constants)

  **What to do**:

  **File: `packages/shared/src/config.schema.ts`**
  - `FrakConfigSchema` → `AtelierConfigSchema` (line 176)
  - `FrakConfig` → `AtelierConfig` (line 188, and type export)
  - `DEFAULT_CONFIG: FrakConfig` → `DEFAULT_CONFIG: AtelierConfig` (line 235)
  - ENV_VAR_MAPPING keys (lines 192-231):
    - `FRAK_DASHBOARD_DOMAIN` → `ATELIER_DASHBOARD_DOMAIN`
    - `FRAK_SANDBOX_DOMAIN_SUFFIX` → `ATELIER_SANDBOX_DOMAIN_SUFFIX`
    - `FRAK_SSH_DOMAIN` → `ATELIER_SSH_DOMAIN`
    - `FRAK_BRIDGE_NAME` → `ATELIER_BRIDGE_NAME`
    - `FRAK_BRIDGE_IP` → `ATELIER_BRIDGE_IP`
    - `FRAK_BRIDGE_CIDR` → `ATELIER_BRIDGE_CIDR`
    - `FRAK_GUEST_SUBNET` → `ATELIER_GUEST_SUBNET`
    - `FRAK_GUEST_IP_START` → `ATELIER_GUEST_IP_START`
    - `FRAK_DNS_SERVERS` → `ATELIER_DNS_SERVERS`
    - `FRAK_VSCODE_PORT` → `ATELIER_VSCODE_PORT`
    - `FRAK_OPENCODE_PORT` → `ATELIER_OPENCODE_PORT`
    - `FRAK_BROWSER_PORT` → `ATELIER_BROWSER_PORT`
    - `FRAK_TERMINAL_PORT` → `ATELIER_TERMINAL_PORT`
    - `FRAK_AGENT_PORT` → `ATELIER_AGENT_PORT`
    - `FRAK_IMAGES_DIR` → `ATELIER_IMAGES_DIR`
    - `FRAK_DEFAULT_IMAGE` → `ATELIER_DEFAULT_IMAGE`
  - `ImagesConfigSchema` default directory (line 167): `/opt/frak-sandbox/infra/images` → `/opt/atelier/infra/images`
  - `DEFAULT_CONFIG.images.directory` (line 283): `/opt/frak-sandbox/infra/images` → `/opt/atelier/infra/images`
  - JSDoc comment (line 2): "FRAK Sandbox" → "L'atelier"
  - Validation message (line 193): `FRAK_SANDBOX_DOMAIN_SUFFIX` → `ATELIER_SANDBOX_DOMAIN_SUFFIX`

  **File: `packages/shared/src/config.loader.ts`**
  - `FrakConfig` import → `AtelierConfig` (line 5)
  - `FrakConfigSchema` import → `AtelierConfigSchema` (line 6)
  - `loadConfig` return type `FrakConfig` → `AtelierConfig` (line 106)
  - `process.env.FRAK_CONFIG` → `process.env.ATELIER_CONFIG` (line 109)
  - `/etc/frak-sandbox/` → `/etc/atelier/` (line 110)
  - `getConfigValue<T>(config: FrakConfig` → `getConfigValue<T>(config: AtelierConfig` (line 124)
  - `validateConfig(config: FrakConfig` → `validateConfig(config: AtelierConfig` (line 152)
  - `assertConfigValid(config: FrakConfig` → `assertConfigValid(config: AtelierConfig` (line 219)
  - `Value.Errors(FrakConfigSchema` → `Value.Errors(AtelierConfigSchema` (line 159)
  - `Value.Default(FrakConfigSchema` → `Value.Default(AtelierConfigSchema` (line 117)
  - `Value.Convert(FrakConfigSchema` → `Value.Convert(AtelierConfigSchema` (line 118)
  - `Value.Clean(FrakConfigSchema` → `Value.Clean(AtelierConfigSchema` (line 119)

  **File: `packages/shared/src/constants.ts`**
  - Comment (line 3): "Frak Sandbox" → "L'atelier"
  - `APP_DIR` (line 19): `/opt/frak-sandbox` → `/opt/atelier`
  - `SESSION_TEMPLATES_CONFIG_PATH` (line 293): `/.frak-sandbox/session-templates.json` → `/.atelier/session-templates.json`

  **File: `packages/shared/src/index.ts`** (check for re-exports)
  - Update any re-exports of `FrakConfig` → `AtelierConfig`, `FrakConfigSchema` → `AtelierConfigSchema`

  **Must NOT do**:
  - Do NOT rename `SANDBOX_MODE` env var (sandbox is a concept)
  - Do NOT change `SANDBOX_DIR`, `SANDBOX_PREFIX`, or any sandbox-concept names
  - Do NOT change VM_PATHS, SSH_PROXY, LVM constants

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]
    - `git-master`: For clean atomic commit

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 6)
  - **Blocks**: Tasks 2, 3, 4
  - **Blocked By**: None

  **References**:
  - `packages/shared/src/config.schema.ts` — Full file: FrakConfigSchema, ENV_VAR_MAPPING, DEFAULT_CONFIG
  - `packages/shared/src/config.loader.ts` — Full file: loadConfig, validateConfig, FrakConfig usage
  - `packages/shared/src/constants.ts` — Lines 19, 293: APP_DIR and SESSION_TEMPLATES_CONFIG_PATH
  - `packages/shared/src/index.ts` — Re-exports to update

  **Acceptance Criteria**:

  ```
  Scenario: No frak-brand strings remain in shared package
    Tool: Bash (grep)
    Steps:
      1. grep -rn "FrakConfig\|FrakConfigSchema\|FRAK_\|frak-sandbox\|frak_sandbox" packages/shared/src/ | grep -v node_modules
      2. Assert: 0 results returned
    Expected Result: No old brand strings in shared package
    Evidence: grep output captured
  
  Scenario: New brand strings exist in shared package
    Tool: Bash (grep)
    Steps:
      1. grep -c "AtelierConfig" packages/shared/src/config.schema.ts
      2. Assert: count ≥ 2
      3. grep -c "AtelierConfigSchema" packages/shared/src/config.schema.ts
      4. Assert: count ≥ 2
      5. grep -c "ATELIER_" packages/shared/src/config.schema.ts
      6. Assert: count ≥ 16
      7. grep "/opt/atelier" packages/shared/src/constants.ts
      8. Assert: match found
      9. grep "/.atelier/" packages/shared/src/constants.ts
      10. Assert: match found
    Expected Result: All new brand strings present
    Evidence: grep output captured
  ```

  **Commit**: YES
  - Message: `refactor(shared): rename FrakConfig → AtelierConfig, FRAK_* → ATELIER_* env vars`
  - Files: `packages/shared/src/config.schema.ts`, `packages/shared/src/config.loader.ts`, `packages/shared/src/constants.ts`, `packages/shared/src/index.ts`
  - Pre-commit: `bun run check`

---

- [ ] 2. Rename all package.json files (names + dependency refs)

  **What to do**:

  **File: `package.json` (root)**
  - `"name": "oc-sandbox"` → `"name": "atelier"`
  - `"build:cli": "bun run --filter @frak-sandbox/cli build:linux"` → `"build:cli": "bun run --filter @frak/atelier-cli build:linux"`

  **File: `packages/shared/package.json`**
  - `"name": "@frak-sandbox/shared"` → `"name": "@frak/atelier-shared"`

  **File: `apps/cli/package.json`**
  - `"name": "@frak-sandbox/cli"` → `"name": "@frak/atelier-cli"`
  - `"build": "... --outfile dist/frak-sandbox"` → `"... --outfile dist/atelier"`
  - `"build:linux": "... --outfile dist/frak-sandbox-linux-x64"` → `"... --outfile dist/atelier-linux-x64"`
  - `"@frak-sandbox/manager": "workspace:*"` → `"@frak/atelier-manager": "workspace:*"`
  - `"@frak-sandbox/shared": "workspace:*"` → `"@frak/atelier-shared": "workspace:*"`

  **File: `apps/manager/package.json`**
  - `"name": "@frak-sandbox/manager"` → `"name": "@frak/atelier-manager"`
  - `"@frak-sandbox/shared": "workspace:*"` → `"@frak/atelier-shared": "workspace:*"`

  **File: `apps/dashboard/package.json`**
  - `"name": "@frak-sandbox/dashboard"` → `"name": "@frak/atelier-dashboard"`
  - `"@frak-sandbox/manager": "workspace:*"` → `"@frak/atelier-manager": "workspace:*"`
  - `"@frak-sandbox/shared": "workspace:*"` → `"@frak/atelier-shared": "workspace:*"`

  **Must NOT do**:
  - Do NOT run `bun install` yet (that's Task 9)
  - Do NOT change any version numbers

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 3, 4, 5)
  - **Blocks**: Tasks 7, 9
  - **Blocked By**: Task 1

  **References**:
  - `package.json` (root) — Lines 2, 7: name and build:cli script
  - `packages/shared/package.json` — Line 2: name
  - `apps/cli/package.json` — Lines 2, 8-9, 12-14: name, build scripts, dependencies
  - `apps/manager/package.json` — Lines 2, 23: name, shared dependency
  - `apps/dashboard/package.json` — Lines 2, 16-17: name, dependencies

  **Acceptance Criteria**:

  ```
  Scenario: No old package names remain
    Tool: Bash (grep)
    Steps:
      1. grep -rn "@frak-sandbox/" package.json packages/shared/package.json apps/*/package.json
      2. Assert: 0 results
      3. grep '"oc-sandbox"' package.json
      4. Assert: 0 results
    Expected Result: All package names updated
    Evidence: grep output

  Scenario: New package names exist
    Tool: Bash (grep)
    Steps:
      1. grep "@frak/atelier-" apps/cli/package.json | wc -l
      2. Assert: count ≥ 2 (shared + manager deps)
      3. grep '"atelier"' package.json
      4. Assert: match found (root name)
    Expected Result: New names in place
    Evidence: grep output
  ```

  **Commit**: YES
  - Message: `refactor: rename @frak-sandbox/* packages to @frak/atelier-*`
  - Files: `package.json`, `packages/shared/package.json`, `apps/cli/package.json`, `apps/manager/package.json`, `apps/dashboard/package.json`
  - Pre-commit: N/A (build will fail until imports updated)

---

- [ ] 3. Update CLI source files

  **What to do**:

  **File: `apps/cli/src/lib/context.ts`**
  - `import { loadConfig } from "@frak-sandbox/shared"` → `from "@frak/atelier-shared"`
  - `"@frak-sandbox/shared/constants"` → `"@frak/atelier-shared/constants"`
  - `export const frakConfig = loadConfig()` → `export const atelierConfig = loadConfig()`

  **File: `apps/cli/src/index.ts`**
  - `"frak-sandbox - Firecracker sandbox management CLI"` → `"atelier - Firecracker sandbox management CLI"`
  - All `"frak-sandbox"` in help text → `"atelier"` (Usage line, examples, references)
  - `p.intro("frak-sandbox")` → `p.intro("atelier")`
  - `update --local  Use local tarball from /tmp/frak-sandbox-deploy.tar.gz` → `from /tmp/atelier-deploy.tar.gz`

  **File: `apps/cli/src/commands/update.ts`**
  - `from "@frak-sandbox/shared"` → `from "@frak/atelier-shared"`
  - `DEFAULT_LOCAL_TARBALL = "/tmp/frak-sandbox-deploy.tar.gz"` → `"/tmp/atelier-deploy.tar.gz"`
  - `/tmp/frak-sandbox-update-` → `/tmp/atelier-update-`
  - `systemctl stop frak-sandbox-manager` → `systemctl stop atelier-manager`
  - ALL `/opt/frak-sandbox` → `/opt/atelier` (lines 87-102, many occurrences)
  - `frak-sandbox-manager.service` → `atelier-manager.service` (lines 106-109)
  - `frak-sandbox-network.service` → `atelier-network.service` (lines 108-109)
  - `/etc/frak-sandbox/` → `/etc/atelier/` (lines 126-131)
  - `chown -R frak:frak /opt/frak-sandbox` → `chown -R atelier:atelier /opt/atelier` (line 135)
  - `systemctl enable frak-sandbox-network frak-sandbox-manager` → `systemctl enable atelier-network atelier-manager` (line 144)
  - `systemctl restart frak-sandbox-manager` → `systemctl restart atelier-manager` (line 150)
  - `process.env.FRAK_RELEASE_REPO` → `process.env.ATELIER_RELEASE_REPO` (line 223)
  - `process.env.FRAK_RELEASE_BASE_URL` → `process.env.ATELIER_RELEASE_BASE_URL` (line 225)
  - `frak-sandbox-server-${version}.tar.gz` → `atelier-server-${version}.tar.gz` (line 227)
  - `process.env.FRAK_CONFIG` → `process.env.ATELIER_CONFIG` (line 238)
  - `'frak-sandbox config set'` → `'atelier config set'` (line 242)

  **File: `apps/cli/src/commands/base-setup.ts`**
  - `mkdir -p /etc/frak-sandbox` → `mkdir -p /etc/atelier`
  - `"getent group frak ..."` → `"getent group atelier ..."` — ALL frak user/group refs
  - `groupadd --gid 1000 frak` → `groupadd --gid 1000 atelier`
  - `useradd --uid 1000 --gid 1000 ... frak` → `... atelier`
  - `usermod -aG kvm,disk frak` → `usermod -aG kvm,disk atelier`
  - `id -u frak` → `id -u atelier`
  - All `frak user` / `frak:frak` references → `atelier` / `atelier:atelier`
  - `chgrp -R frak /etc/frak-sandbox` → `chgrp -R atelier /etc/atelier`
  - `chmod 750 /etc/frak-sandbox` → `chmod 750 /etc/atelier`
  - `sudoersPath = "/etc/sudoers.d/frak-sandbox"` → `"/etc/sudoers.d/atelier"`
  - `frak ALL=(root) NOPASSWD:` → `atelier ALL=(root) NOPASSWD:`
  - `p.note` summary: `"User: frak (sudoers + kvm)"` → `"User: atelier (sudoers + kvm)"`

  **File: `apps/cli/src/commands/config.ts`**
  - `from "@frak-sandbox/shared"` → `from "@frak/atelier-shared"`
  - `process.env.FRAK_CONFIG` → `process.env.ATELIER_CONFIG`
  - `/etc/frak-sandbox/` → `/etc/atelier/`

  **File: `apps/cli/src/commands/deploy-manager.ts`**
  - `MANAGER_SERVICE = "frak-sandbox-manager"` → `"atelier-manager"`

  **File: `apps/cli/src/commands/images.ts`**
  - `from "@frak-sandbox/shared"` → `from "@frak/atelier-shared"`
  - `frakConfig` → `atelierConfig` (all occurrences)
  - `"frak-sandbox base"` → `"atelier base"`
  - `"frak-sandbox update"` → `"atelier update"`
  - `docker build ... -t frak-sandbox/${imageName}` → `-t atelier/${imageName}`
  - `docker create --name ${containerName} frak-sandbox/${imageName}` → `atelier/${imageName}`

  **File: `apps/cli/src/commands/init.ts`**
  - `from "@frak-sandbox/shared"` → `from "@frak/atelier-shared"`
  - `"frak-sandbox manager status"` → `"atelier manager status"`
  - `"frak-sandbox images dev-base"` → `"atelier images dev-base"`
  - `"frak-sandbox storage"` → `"atelier storage"`
  - `process.env.FRAK_CONFIG` → `process.env.ATELIER_CONFIG`
  - `/etc/frak-sandbox/` → `/etc/atelier/`

  **File: `apps/cli/src/commands/setup-network.ts`**
  - `from "@frak-sandbox/shared"` → `from "@frak/atelier-shared"`
  - `frakConfig` → `atelierConfig` (ALL occurrences — ~30+)
  - `Before=frak-sandbox-manager.service` → `Before=atelier-manager.service`

  **File: `apps/cli/src/commands/setup-storage.ts`**
  - `from "@frak-sandbox/shared"` → `from "@frak/atelier-shared"`
  - `"frak-sandbox images dev-base"` → `"atelier images dev-base"`

  **File: `apps/cli/src/commands/setup-ssh-proxy.ts`**
  - `from "@frak-sandbox/shared/constants"` → `from "@frak/atelier-shared/constants"`
  - `frakConfig` → `atelierConfig` (all occurrences)
  - `"# Managed by frak-sandbox manager"` → `"# Managed by atelier manager"`

  **File: `apps/cli/src/commands/debug-vm.ts`**
  - `frakConfig` → `atelierConfig` (ALL occurrences — ~20+)
  - `"frak-sandbox debug-vm ssh"` → `"atelier debug-vm ssh"`
  - `"frak-sandbox debug-vm stop"` → `"atelier debug-vm stop"`
  - `"frak-sandbox network"` → `"atelier network"`
  - `"frak-sandbox firecracker"` → `"atelier firecracker"`
  - `"frak-sandbox base"` → `"atelier base"`

  **File: `apps/cli/src/commands/version.ts`**
  - `"frak-sandbox v${CLI_VERSION}"` → `"atelier v${CLI_VERSION}"`

  **Must NOT do**:
  - Do NOT change any logic or control flow
  - Do NOT rename `sandboxService`, `sandboxId`, `SANDBOX_MODE`, or any sandbox-concept names
  - Do NOT change GitHub repo references `frak-id/oc-sandbox`

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 2, 4, 5)
  - **Blocks**: Tasks 8, 9
  - **Blocked By**: Task 1

  **References**:
  - `apps/cli/src/lib/context.ts` — Lines 1-14: imports and frakConfig export
  - `apps/cli/src/index.ts` — Lines 112-177: help text with all CLI command examples
  - `apps/cli/src/commands/update.ts` — Full file: extensive frak-sandbox paths
  - `apps/cli/src/commands/base-setup.ts` — Lines 130-202: user/group creation, sudoers
  - `apps/cli/src/commands/config.ts` — Line 136: FRAK_CONFIG env var
  - `apps/cli/src/commands/deploy-manager.ts` — Line 5: service name constant
  - `apps/cli/src/commands/images.ts` — Docker image names, frakConfig usage
  - `apps/cli/src/commands/init.ts` — CLI command suggestions
  - `apps/cli/src/commands/setup-network.ts` — Extensive frakConfig usage
  - `apps/cli/src/commands/setup-storage.ts` — CLI command refs
  - `apps/cli/src/commands/setup-ssh-proxy.ts` — frakConfig usage
  - `apps/cli/src/commands/debug-vm.ts` — Extensive frakConfig usage, CLI refs
  - `apps/cli/src/commands/version.ts` — Version output string

  **Acceptance Criteria**:

  ```
  Scenario: No frak-brand strings in CLI source
    Tool: Bash (grep)
    Steps:
      1. grep -rn "frak-sandbox\|frakConfig\|@frak-sandbox\|FRAK_\|frak:frak\|\"frak\"" apps/cli/src/ | grep -v node_modules
      2. Assert: 0 results (except possibly GitHub repo URLs which are intentionally kept)
    Expected Result: All CLI source updated
    Evidence: grep output

  Scenario: New brand strings in CLI
    Tool: Bash (grep)
    Steps:
      1. grep -c "atelierConfig" apps/cli/src/lib/context.ts
      2. Assert: count ≥ 1
      3. grep "atelier" apps/cli/src/commands/version.ts
      4. Assert: match found
    Expected Result: New names present
    Evidence: grep output
  ```

  **Commit**: YES
  - Message: `refactor(cli): rebrand frak-sandbox → atelier across all CLI commands`
  - Files: All `apps/cli/src/**/*.ts`
  - Pre-commit: `bun run check`

---

- [ ] 4. Update Manager source files

  **What to do**:

  **File: `apps/manager/src/shared/lib/config.ts`**
  - `from "@frak-sandbox/shared"` → `from "@frak/atelier-shared"`
  - `from "@frak-sandbox/shared/constants"` → `from "@frak/atelier-shared/constants"`
  - `const frakConfig = loadConfig()` → `const atelierConfig = loadConfig()`
  - ALL `frakConfig.` → `atelierConfig.` (lines 10-53, ~20 occurrences)

  **File: `apps/manager/src/shared/lib/paths.ts`**
  - `APP_NAME = "frak-sandbox"` → `APP_NAME = "atelier"`

  **File: `apps/manager/src/index.ts`**
  - `from "@frak-sandbox/shared"` → `from "@frak/atelier-shared"`
  - `"Frak Sandbox Manager API"` → `"L'atelier Manager API"` (swagger title, line 140)
  - `"Frak Sandbox Manager"` → `"L'atelier Manager"` (root endpoint, line 228)
  - `"Frak Sandbox Manager started"` → `"L'atelier Manager started"` (log message, line 247)

  **File: `apps/manager/src/infrastructure/storage/shared-storage.service.ts`**
  - `chown frak:frak` → `chown atelier:atelier` (line 264)

  **File: `apps/manager/src/infrastructure/registry/registry.service.ts`**
  - `from "@frak-sandbox/shared/constants"` → `from "@frak/atelier-shared/constants"`
  - `"frak-registry-cache"` → `"atelier-registry-cache"` (line 116)

  **All other files with `@frak-sandbox/shared` imports** (use grep to find):
  - Replace `from "@frak-sandbox/shared"` → `from "@frak/atelier-shared"`
  - Replace `from "@frak-sandbox/shared/constants"` → `from "@frak/atelier-shared/constants"`
  - Replace `from "@frak-sandbox/shared/config"` → `from "@frak/atelier-shared/config"`
  - Replace `from "@frak-sandbox/shared/config-loader"` → `from "@frak/atelier-shared/config-loader"`
  - Replace `from "@frak-sandbox/shared/sandbox-config"` → `from "@frak/atelier-shared/sandbox-config"`
  - Replace `from "@frak-sandbox/shared/sandbox-config-loader"` → `from "@frak/atelier-shared/sandbox-config-loader"`

  **Must NOT do**:
  - Do NOT change `sandbox-provision` service name (concept)
  - Do NOT change `sandbox@frak.dev` email (TBD)
  - Do NOT change `SandboxService`, `sandboxService`, `SandboxError`, etc. (concept)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 2, 3, 5)
  - **Blocks**: Tasks 8, 9
  - **Blocked By**: Task 1

  **References**:
  - `apps/manager/src/shared/lib/config.ts` — Full file: frakConfig usage throughout
  - `apps/manager/src/shared/lib/paths.ts` — Line 4: APP_NAME constant
  - `apps/manager/src/index.ts` — Lines 140, 228, 247: display names
  - `apps/manager/src/infrastructure/storage/shared-storage.service.ts` — Line 264: chown
  - `apps/manager/src/infrastructure/registry/registry.service.ts` — Lines 5, 116: import + cache name

  **Acceptance Criteria**:

  ```
  Scenario: No frak-brand strings in Manager source
    Tool: Bash (grep)
    Steps:
      1. grep -rn "frakConfig\|@frak-sandbox\|frak-sandbox\|FRAK_\|frak:frak" apps/manager/src/ | grep -v node_modules | grep -v "frak-id" | grep -v "frak.dev" | grep -v "frak.id"
      2. Assert: 0 results
    Expected Result: All Manager source updated
    Evidence: grep output

  Scenario: New brand strings in Manager
    Tool: Bash (grep)
    Steps:
      1. grep "atelierConfig" apps/manager/src/shared/lib/config.ts | wc -l
      2. Assert: count ≥ 15
      3. grep '"atelier"' apps/manager/src/shared/lib/paths.ts
      4. Assert: match found
    Expected Result: New names present
    Evidence: grep output
  ```

  **Commit**: YES
  - Message: `refactor(manager): rebrand frak-sandbox → atelier in manager API`
  - Files: All `apps/manager/src/**/*.ts` with changes
  - Pre-commit: `bun run check`

---

- [ ] 5. Update deployment script + CI workflow

  **What to do**:

  **File: `scripts/deploy.ts`**
  - `TARBALL_NAME = "frak-sandbox-deploy.tar.gz"` → `"atelier-deploy.tar.gz"`
  - `bun run --filter @frak-sandbox/cli build:linux` → `@frak/atelier-cli`
  - `bun run --filter @frak-sandbox/manager build` → `@frak/atelier-manager`
  - `bun run --filter @frak-sandbox/dashboard build` → `@frak/atelier-dashboard`
  - ALL `opt/frak-sandbox` → `opt/atelier` in staging dirs (lines 85-133, ~15 occurrences)
  - `etc/frak-sandbox` → `etc/atelier` (lines 92, 136)
  - `frak-sandbox-linux-x64` → `atelier-linux-x64` (line 99)
  - `usr/local/bin/frak-sandbox` → `usr/local/bin/atelier` (line 100)
  - `frak-sandbox-manager.service` → `atelier-manager.service` (lines 141-143)
  - `frak-sandbox-network.service` → `atelier-network.service` (lines 145-147)
  - `const frakConfig = loadConfig(...)` → `const atelierConfig = loadConfig(...)` and all `frakConfig.` refs
  - Install script (inline): ALL `/opt/frak-sandbox` → `/opt/atelier`, `/etc/frak-sandbox` → `/etc/atelier`
  - `systemctl stop frak-sandbox-manager` → `systemctl stop atelier-manager`
  - `pkill -9 frak-sandbox` → `pkill -9 atelier`
  - `cp ... /usr/local/bin/frak-sandbox` → `/usr/local/bin/atelier`
  - `chmod +x /usr/local/bin/frak-sandbox` → `/usr/local/bin/atelier`
  - `systemctl enable frak-sandbox-network frak-sandbox-manager` → `atelier-network atelier-manager`
  - `systemctl restart frak-sandbox-manager` → `atelier-manager`
  - `"frak-sandbox images build dev-base"` → `"atelier images build dev-base"`

  **File: `.github/workflows/release.yml`**
  - `bun run --filter @frak-sandbox/cli build:linux` → `@frak/atelier-cli`
  - `bun run --filter @frak-sandbox/manager build` → `@frak/atelier-manager`
  - `bun run --filter @frak-sandbox/dashboard build` → `@frak/atelier-dashboard`
  - ALL `opt/frak-sandbox` → `opt/atelier` in staging (lines 50-61)
  - `frak-sandbox-manager.service` → `atelier-manager.service` (line 60)
  - `frak-sandbox-network.service` → `atelier-network.service` (line 61)
  - `frak-sandbox-server-${VERSION}.tar.gz` → `atelier-server-${VERSION}.tar.gz` (line 64)
  - `frak-sandbox-linux-x64` → `atelier-linux-x64` in checksums (line 65)
  - Release artifact patterns (lines 71-72): `frak-sandbox-server-*.tar.gz` → `atelier-server-*.tar.gz`, `frak-sandbox-linux-x64` → `atelier-linux-x64`

  **Must NOT do**:
  - Do NOT change GitHub repo URLs or release URLs (repo rename is separate)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 2, 3, 4)
  - **Blocks**: Tasks 8, 9
  - **Blocked By**: Task 6 (systemd file renames must happen first)

  **References**:
  - `scripts/deploy.ts` — Full file: extensive path references throughout
  - `.github/workflows/release.yml` — Full file: build, package, release artifact names

  **Acceptance Criteria**:

  ```
  Scenario: No frak-brand in deploy/CI
    Tool: Bash (grep)
    Steps:
      1. grep -n "frak-sandbox\|@frak-sandbox\|frakConfig\|FRAK_" scripts/deploy.ts .github/workflows/release.yml | grep -v "frak-id"
      2. Assert: 0 results
    Expected Result: Deploy and CI fully updated
    Evidence: grep output
  ```

  **Commit**: YES
  - Message: `refactor(infra): rebrand frak-sandbox → atelier in deploy script and CI workflow`
  - Files: `scripts/deploy.ts`, `.github/workflows/release.yml`
  - Pre-commit: `bun run check`

---

- [ ] 6. Rename + update infrastructure files (systemd, Docker, scripts, Caddy)

  **What to do**:

  **Systemd service file renames** (use `git mv`):
  - `git mv infra/systemd/frak-sandbox-manager.service infra/systemd/atelier-manager.service`
  - `git mv infra/systemd/frak-sandbox-network.service infra/systemd/atelier-network.service`

  **File: `infra/systemd/atelier-manager.service` (after rename)**
  - `Description=Frak Sandbox Manager API` → `Description=L'atelier Manager API`
  - `Documentation=https://github.com/frak-id/frak-sandbox` → keep as-is (actual URL)
  - `After=... frak-sandbox-network.service` → `atelier-network.service`
  - `Wants=frak-sandbox-network.service` → `atelier-network.service`
  - `User=frak` → `User=atelier`
  - `Group=frak` → `Group=atelier`
  - `WorkingDirectory=/opt/frak-sandbox` → `/opt/atelier`
  - `DATA_DIR=/opt/frak-sandbox/data` → `/opt/atelier/data`
  - `MIGRATIONS_DIR=/opt/frak-sandbox/drizzle` → `/opt/atelier/drizzle`
  - `SyslogIdentifier=frak-sandbox-manager` → `SyslogIdentifier=atelier-manager`

  **File: `infra/systemd/atelier-network.service` (after rename)**
  - `Description=Frak Sandbox Network Bridge` → `Description=L'atelier Network Bridge`
  - `Documentation=https://github.com/frak-id/frak-sandbox` → keep as-is
  - `ExecStart=frak-sandbox network` → `ExecStart=atelier network`

  **File: `infra/caddy/Caddyfile.template`**
  - `root * /opt/frak-sandbox/apps/dashboard/dist` → `/opt/atelier/apps/dashboard/dist`

  **File: `infra/scripts/install.sh`**
  - `REPO="${FRAK_REPO:-frak-id/oc-sandbox}"` → `REPO="${ATELIER_REPO:-frak-id/oc-sandbox}"`
  - `VERSION="${FRAK_VERSION:-}"` → `VERSION="${ATELIER_VERSION:-}"`
  - `CLI_NAME="frak-sandbox"` → `CLI_NAME="atelier"`
  - `CLI_URL=".../frak-sandbox-linux-x64"` → `".../atelier-linux-x64"`

  **File: `infra/images/build-image.sh`**
  - `docker build -t "frak-sandbox/$IMAGE_NAME"` → `"atelier/$IMAGE_NAME"`
  - `docker create --name "$CONTAINER_NAME" "frak-sandbox/$IMAGE_NAME"` → `"atelier/$IMAGE_NAME"`

  **File: `infra/images/dev-base/Dockerfile`**
  - Comment: `# Frak Sandbox - dev-base image` → `# L'atelier - dev-base image`
  - `# Build: docker build -t frak-sandbox/dev-base .` → `atelier/dev-base`
  - `# Export: docker export $(docker create frak-sandbox/dev-base)` → `atelier/dev-base`
  - `# All paths owned by dev:dev (UID/GID 1000) to match host frak user` → `to match host atelier user`
  - `/.frak-sandbox \` → `/.atelier \` (line 71)
  - `chown -R dev:dev ... /.frak-sandbox` → `/.atelier` (line 72)
  - `chmod 775 ... /.frak-sandbox` → `/.atelier` (line 73)

  **File: `infra/images/dev-cloud/Dockerfile`**
  - Comment: `# Frak Sandbox - dev-cloud image` → `# L'atelier - dev-cloud image`
  - `# Build: docker build -t frak-sandbox/dev-cloud .` → `atelier/dev-cloud`
  - `# Requires: frak-sandbox/dev-base` → `atelier/dev-base`
  - `FROM frak-sandbox/dev-base:latest` → `FROM atelier/dev-base:latest`

  **Must NOT do**:
  - Do NOT change GitHub Documentation URLs in systemd files (they point to actual repo)
  - Do NOT change VM internal paths `/etc/sandbox/`, `/var/lib/sandbox/`, `/var/log/sandbox/`
  - Do NOT change `sandbox-agent` binary name in Dockerfile

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]
    - `git-master`: Critical for `git mv` file renames

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: Task 5
  - **Blocked By**: None

  **References**:
  - `infra/systemd/frak-sandbox-manager.service` — Full file (32 lines): all content needs updating
  - `infra/systemd/frak-sandbox-network.service` — Full file (13 lines): all content needs updating
  - `infra/caddy/Caddyfile.template` — Line 30: dashboard static files path
  - `infra/scripts/install.sh` — Lines 4-6, 56: env var names, CLI name, download URL
  - `infra/images/build-image.sh` — Lines 45, 51: Docker image names
  - `infra/images/dev-base/Dockerfile` — Lines 1, 5-6, 64, 71-73: comments, user ref, /.frak-sandbox
  - `infra/images/dev-cloud/Dockerfile` — Lines 1, 4-5, 7: comments, FROM directive

  **Acceptance Criteria**:

  ```
  Scenario: Systemd files renamed
    Tool: Bash (test)
    Steps:
      1. test -f infra/systemd/atelier-manager.service
      2. Assert: exists
      3. test -f infra/systemd/atelier-network.service
      4. Assert: exists
      5. test ! -f infra/systemd/frak-sandbox-manager.service
      6. Assert: old file gone
      7. test ! -f infra/systemd/frak-sandbox-network.service
      8. Assert: old file gone
    Expected Result: Files renamed
    Evidence: test results

  Scenario: No frak-brand in infra files
    Tool: Bash (grep)
    Steps:
      1. grep -rn "frak-sandbox\|frak:frak\|/frak\b\|FRAK_" infra/ | grep -v "frak-id"
      2. Assert: 0 results
    Expected Result: All infra files updated
    Evidence: grep output
  ```

  **Commit**: YES
  - Message: `refactor(infra): rename systemd services and rebrand infrastructure files`
  - Files: `infra/systemd/atelier-manager.service`, `infra/systemd/atelier-network.service`, `infra/caddy/Caddyfile.template`, `infra/scripts/install.sh`, `infra/images/build-image.sh`, `infra/images/dev-base/Dockerfile`, `infra/images/dev-cloud/Dockerfile`
  - Pre-commit: N/A (shell/docker files not linted)

---

- [ ] 7. Update Dashboard source files

  **What to do**:

  **File: `apps/dashboard/index.html`**
  - `<title>Frak Sandbox Dashboard</title>` → `<title>L'atelier</title>`

  **File: `apps/dashboard/src/routes/__root.tsx`**
  - `<span className="font-bold text-lg">Frak Sandbox</span>` → `L'atelier` (3 occurrences: desktop sidebar, mobile sheet header, mobile header)

  **File: `apps/dashboard/src/components/login-page.tsx`**
  - `<CardTitle className="text-xl">Frak Sandbox</CardTitle>` → `L'atelier`

  **File: `apps/dashboard/src/components/ssh-keys-section.tsx`**
  - `SSH_HOST_ALIAS = "frak-sandbox"` → `"atelier"`

  **File: `apps/dashboard/src/routes/tasks/index.tsx`**
  - `localStorage.getItem("frak_task_view")` → `"atelier_task_view"` (line 71)
  - `localStorage.setItem("frak_task_view", view)` → `"atelier_task_view"` (line 82)

  **All dashboard files with `@frak-sandbox/` imports**:
  - `@frak-sandbox/manager` → `@frak/atelier-manager` (in import paths)
  - `@frak-sandbox/shared` → `@frak/atelier-shared` (in import paths)
  - Use grep to find ALL occurrences in `apps/dashboard/src/`

  **Must NOT do**:
  - Do NOT touch `routeTree.gen.ts` (auto-generated)
  - Do NOT change any component logic or styling

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (solo)
  - **Blocks**: Tasks 8, 9
  - **Blocked By**: Task 2 (package names must be updated first)

  **References**:
  - `apps/dashboard/index.html` — Line 7: page title
  - `apps/dashboard/src/routes/__root.tsx` — Lines 292, 327, 361: "Frak Sandbox" branding in 3 places
  - `apps/dashboard/src/components/login-page.tsx` — Line 44: login page title
  - `apps/dashboard/src/components/ssh-keys-section.tsx` — Line 74: SSH_HOST_ALIAS
  - `apps/dashboard/src/routes/tasks/index.tsx` — Lines 71, 82: localStorage key

  **Acceptance Criteria**:

  ```
  Scenario: No frak-brand in Dashboard
    Tool: Bash (grep)
    Steps:
      1. grep -rn "Frak Sandbox\|frak-sandbox\|frak_task_view\|@frak-sandbox" apps/dashboard/src/ apps/dashboard/index.html | grep -v node_modules | grep -v routeTree.gen.ts
      2. Assert: 0 results
    Expected Result: All Dashboard files updated
    Evidence: grep output

  Scenario: New brand in Dashboard
    Tool: Bash (grep)
    Steps:
      1. grep "L'atelier" apps/dashboard/index.html
      2. Assert: match found
      3. grep "L'atelier" apps/dashboard/src/routes/__root.tsx | wc -l
      4. Assert: count ≥ 3
      5. grep "atelier_task_view" apps/dashboard/src/routes/tasks/index.tsx | wc -l
      6. Assert: count ≥ 2
    Expected Result: New branding in place
    Evidence: grep output
  ```

  **Commit**: YES
  - Message: `refactor(dashboard): rebrand Frak Sandbox → L'atelier in UI`
  - Files: `apps/dashboard/index.html`, `apps/dashboard/src/routes/__root.tsx`, `apps/dashboard/src/components/login-page.tsx`, `apps/dashboard/src/components/ssh-keys-section.tsx`, `apps/dashboard/src/routes/tasks/index.tsx`
  - Pre-commit: `bun run check`

---

- [ ] 8. Update all documentation files

  **What to do**:

  Apply these replacements across ALL documentation files:
  - `"Frak Sandbox"` → `"L'atelier"` (display name)
  - `"FRAK Sandbox"` → `"L'atelier"` (header variant)
  - `"FRAK"` (when referring to the product, NOT the org) → `"L'atelier"` or `"Atelier"`
  - `frak-sandbox` (CLI command refs) → `atelier`
  - `/opt/frak-sandbox` → `/opt/atelier`
  - `/etc/frak-sandbox` → `/etc/atelier`
  - `FRAK_CONFIG` → `ATELIER_CONFIG`
  - `FRAK_BRIDGE_IP` etc → `ATELIER_BRIDGE_IP` etc
  - `frak-sandbox-manager.service` → `atelier-manager.service`
  - `frak-sandbox-network.service` → `atelier-network.service`
  - `frak-sandbox-deploy.tar.gz` → `atelier-deploy.tar.gz`
  - `@frak-sandbox/` → `@frak/atelier-`
  - `frak-sandbox/dev-base` → `atelier/dev-base` (Docker image)
  - `frak user` / `frak group` → `atelier user` / `atelier group`

  **Files to update**:
  - `README.md`
  - `AGENTS.md` (root)
  - `CONTRIBUTING.md`
  - `SECURITY.md`
  - `docs/design-spec.md`
  - `docs/infrastructure.md`
  - `docs/setup.md`
  - `docs/patterns.md`
  - `docs/constraints.md`
  - `docs/MANUAL_SETUP_COMMANDS.md`
  - `docs/roadmap/README.md`
  - `docs/roadmap/phase-1-public-release.md`
  - `docs/roadmap/phase-2-killer-features.md`
  - `docs/roadmap/swarm-architecture.md`
  - `docs/roadmap/competitive-analysis.md`
  - `apps/cli/AGENTS.md`
  - `apps/manager/AGENTS.md`
  - `apps/dashboard/AGENTS.md`
  - Any other `AGENTS.md` files in subdirectories

  **Must NOT do**:
  - Do NOT change GitHub repo URLs `frak-id/oc-sandbox` (actual repo)
  - Do NOT rewrite prose — only change brand names
  - Do NOT change `@frak` org scope references
  - Do NOT change `sandbox` concept references (sandbox-agent, sandbox-vg, etc.)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 4 (solo, after all code changes)
  - **Blocks**: Task 9
  - **Blocked By**: Tasks 3, 4, 5, 7

  **References**:
  - `README.md` — Full file: project title, install command, CLI examples, config paths
  - `AGENTS.md` — Full file: project description, commands, conventions
  - All `docs/*.md` and `docs/roadmap/*.md` files
  - All `apps/*/AGENTS.md` files

  **Acceptance Criteria**:

  ```
  Scenario: No frak-brand in docs (except GitHub URLs)
    Tool: Bash (grep)
    Steps:
      1. grep -rn "frak-sandbox\|Frak Sandbox\|FRAK Sandbox\|@frak-sandbox\|/opt/frak-sandbox\|/etc/frak-sandbox\|FRAK_CONFIG\|FRAK_BRIDGE" docs/ README.md AGENTS.md CONTRIBUTING.md SECURITY.md apps/*/AGENTS.md | grep -v "frak-id/"
      2. Assert: 0 results
    Expected Result: All docs updated
    Evidence: grep output
  ```

  **Commit**: YES
  - Message: `docs: rebrand Frak Sandbox → L'atelier across all documentation`
  - Files: All `*.md` files with changes
  - Pre-commit: N/A

---

- [ ] 9. Final verification: bun install + typecheck + lint + comprehensive grep

  **What to do**:

  1. Run `bun install` to regenerate `bun.lock` with new package names
  2. Run `bun run typecheck` to verify TypeScript compiles clean
  3. Run `bun run check` to verify Biome lint/format passes
  4. Run comprehensive grep checks to verify no old brand strings remain
  5. Run build commands for each package to verify they still build

  **Verification commands**:
  ```bash
  # 1. Regenerate lockfile
  bun install

  # 2. TypeScript
  bun run typecheck

  # 3. Lint
  bun run check

  # 4. Comprehensive grep (MUST all return 0 results)
  grep -rn "frak-sandbox" --include="*.ts" --include="*.tsx" --include="*.json" --include="*.sh" --include="*.yml" --include="*.service" --include="*.md" . | grep -v node_modules | grep -v bun.lock | grep -v .sisyphus | grep -v "frak-id/" | grep -v ".git/"
  
  grep -rn "@frak-sandbox/" . | grep -v node_modules | grep -v bun.lock | grep -v .git/
  
  grep -rn "FRAK_" --include="*.ts" --include="*.tsx" . | grep -v node_modules
  
  grep -rn "/opt/frak-sandbox" . | grep -v node_modules | grep -v bun.lock | grep -v .sisyphus | grep -v .git/
  
  grep -rn "/etc/frak-sandbox" . | grep -v node_modules | grep -v bun.lock | grep -v .sisyphus | grep -v .git/
  
  grep -rn "FrakConfig\|FrakConfigSchema\|frakConfig" --include="*.ts" --include="*.tsx" . | grep -v node_modules

  # 5. Verify preserved concepts still exist
  grep -rn "sandboxService\|sandboxId\|SANDBOX_MODE\|sandbox-agent" --include="*.ts" . | grep -v node_modules | head -5
  # Assert: results exist (concept preserved)

  # 6. Build verification
  bun run --filter @frak/atelier-cli build
  bun run --filter @frak/atelier-manager build
  bun run --filter @frak/atelier-dashboard build
  ```

  **If any grep returns results**: fix the remaining occurrences before proceeding.
  **If typecheck or lint fails**: fix the errors (likely missed renames or import paths).

  **Must NOT do**:
  - Do NOT make changes beyond fixing missed renames
  - Do NOT refactor or improve anything

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 5 (final, solo)
  - **Blocks**: None (final task)
  - **Blocked By**: ALL previous tasks

  **References**:
  - Root `package.json` — Build scripts using new package names
  - `bun.lock` — Will be regenerated (don't manually edit)

  **Acceptance Criteria**:

  ```
  Scenario: bun install succeeds
    Tool: Bash
    Steps:
      1. bun install
      2. Assert: exit code 0
    Expected Result: Lockfile regenerated cleanly
    Evidence: Command output

  Scenario: TypeScript compiles clean
    Tool: Bash
    Steps:
      1. bun run typecheck
      2. Assert: exit code 0
    Expected Result: No type errors
    Evidence: Command output

  Scenario: Lint passes
    Tool: Bash
    Steps:
      1. bun run check
      2. Assert: exit code 0
    Expected Result: No lint errors
    Evidence: Command output

  Scenario: No old brand strings remain
    Tool: Bash (grep)
    Steps:
      1. Run all 6 grep commands from verification list above
      2. Assert: all return 0 results (except preserved concepts check which MUST return results)
    Expected Result: Complete rebrand, concepts preserved
    Evidence: All grep outputs captured

  Scenario: All packages build
    Tool: Bash
    Steps:
      1. bun run --filter @frak/atelier-manager build
      2. Assert: exit code 0
      3. bun run --filter @frak/atelier-dashboard build
      4. Assert: exit code 0
    Expected Result: All packages build successfully
    Evidence: Build outputs captured
  ```

  **Commit**: YES
  - Message: `chore: regenerate bun.lock after rebrand and fix any remaining references`
  - Files: `bun.lock` + any files with missed renames
  - Pre-commit: `bun run typecheck && bun run check`

---

## Commit Strategy

| After Task | Message | Key Files | Verification |
|------------|---------|-----------|--------------|
| 1 | `refactor(shared): rename FrakConfig → AtelierConfig, FRAK_* → ATELIER_* env vars` | packages/shared/src/*.ts | grep |
| 2 | `refactor: rename @frak-sandbox/* packages to @frak/atelier-*` | */package.json | grep |
| 3 | `refactor(cli): rebrand frak-sandbox → atelier across all CLI commands` | apps/cli/src/**/*.ts | grep |
| 4 | `refactor(manager): rebrand frak-sandbox → atelier in manager API` | apps/manager/src/**/*.ts | grep |
| 5 | `refactor(infra): rebrand frak-sandbox → atelier in deploy script and CI workflow` | scripts/deploy.ts, .github/workflows/release.yml | grep |
| 6 | `refactor(infra): rename systemd services and rebrand infrastructure files` | infra/**/* | test + grep |
| 7 | `refactor(dashboard): rebrand Frak Sandbox → L'atelier in UI` | apps/dashboard/**/* | grep |
| 8 | `docs: rebrand Frak Sandbox → L'atelier across all documentation` | **/*.md | grep |
| 9 | `chore: regenerate bun.lock after rebrand and fix remaining references` | bun.lock | typecheck + lint + grep |

---

## Success Criteria

### Verification Commands
```bash
bun install          # Expected: exit 0, clean lockfile
bun run typecheck    # Expected: exit 0, no errors
bun run check        # Expected: exit 0, no lint issues

# Zero old brand references (excluding GitHub URLs and git history)
grep -rn "frak-sandbox\|@frak-sandbox\|FrakConfig\|frakConfig\|FRAK_\|/opt/frak-sandbox\|/etc/frak-sandbox" --include="*.ts" --include="*.tsx" --include="*.json" --include="*.sh" --include="*.yml" --include="*.service" --include="*.md" . | grep -v node_modules | grep -v bun.lock | grep -v .sisyphus | grep -v "frak-id/" | grep -v ".git/"
# Expected: 0 lines

# Sandbox concept preserved
grep -c "sandbox" packages/shared/src/constants.ts
# Expected: > 10
```

### Final Checklist
- [ ] All "Must Have" present (complete rebrand)
- [ ] All "Must NOT Have" absent (no concept renames, no repo URL changes)
- [ ] `bun install` + `bun run typecheck` + `bun run check` all pass
- [ ] Systemd service files renamed (old files gone)
- [ ] All package builds succeed
