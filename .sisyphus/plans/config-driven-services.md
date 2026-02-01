# Config-Driven Agent Services Migration

## TL;DR

> **Quick Summary**: Migrate from hardcoded service definitions to config-driven, agent-owned services where service commands, users, and autoStart flags are injected via config.json. Browser becomes 4 discrete agent-managed services instead of exec fire-and-forget.
>
> **Deliverables**:
> - Extended shared TypeBox schema with command/user/autoStart/env fields
> - Rust agent reading service definitions from config (no hardcoded commands)
> - Agent auto-starting services on boot
> - Provisioner building full service definitions in config.json
> - Browser routes using agent service start/stop instead of exec
> - Minimal init script (mount, network, agent, sshd only)
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: Task 1 (shared schema) → Task 3 (agent config) → Task 4 (agent services) → Task 6 (provisioner) → Task 7 (browser routes)

---

## Context

### Original Request
Full migration to config-driven, agent-owned services: agent reads service definitions from config.json, auto-starts on boot, init script minimal, browser = 4 services, manager browser routes use agent endpoints, remove OpenCode plugin SDK, review VS Code extension install.

### Architecture Decision
**Config-driven (Option A)** confirmed by Oracle: service definitions (command, user, port, autoStart, env) come from `/etc/sandbox/config.json`. Agent is a generic process manager. Manager injects config before boot.

### Key Research Findings
- Agent `services.rs` (512 lines): Hardcoded `SERVICE_DEFS` array with 3 services, fn-based command/port templates reading from fixed `SandboxServices` struct fields
- Agent `config.rs`: Fixed `SandboxServices` struct with named fields (vscode, opencode, terminal, browser, agent)
- Agent `health.rs`: Hardcoded port reads from named struct fields (`s.vscode.port`, `s.opencode.port`, etc.)
- Agent `main.rs`: Calls `discover_running_services()` on startup — needs to become `start_autostart_services()`
- Manager `sandbox.provisioner.ts:134-172`: Builds config.json with only `{ port }` per service
- Manager `sandbox.routes.ts:591-723`: Browser start/stop via exec with sleep-based sequencing
- Manager `sandbox-spawner.ts`: `reconfigureRestoredGuest()` hardcodes `["code-server", "opencode", "ttyd"]` for service start
- Init script lines 144-201: Starts code-server, extensions, opencode plugin SDK, opencode, ttyd — all to be removed

---

## Work Objectives

### Core Objective
Transform the agent from a service manager with hardcoded definitions into a generic, config-driven process manager where all service definitions come from the provisioner-injected config.json.

### Concrete Deliverables
- `packages/shared/src/config.schema.ts` — New `SandboxServiceEntrySchema` with command/user/autoStart/env
- `packages/shared/src/sandbox-config.schema.ts` — Services as `Record<string, SandboxServiceEntry>`
- `apps/agent-rust/src/config.rs` — `ServiceConfig` with command/user/autoStart/env, `HashMap<String, ServiceConfig>` for services
- `apps/agent-rust/src/routes/services.rs` — Config-driven lookup, autoStart on boot, env var support
- `apps/agent-rust/src/routes/health.rs` — Dynamic port checking from config
- `apps/agent-rust/src/main.rs` — Call `start_autostart_services()` instead of `discover_running_services()`
- `apps/manager/src/modules/sandbox/sandbox.provisioner.ts` — Full service definitions with resolved commands
- `apps/manager/src/api/sandbox.routes.ts` — Browser routes via agent serviceStart/serviceStop
- `apps/manager/src/orchestrators/sandbox-spawner.ts` — Use config-aware service names
- `infra/images/dev-base/rootfs/etc/sandbox/sandbox-init.sh` — Strip to minimal

### Definition of Done
- [ ] Agent starts services based on config.json `autoStart: true` on boot
- [ ] Agent can start/stop/restart any service defined in config (including browser sub-services)
- [ ] Health endpoint dynamically reports all configured services with ports
- [ ] Browser start/stop works via 4 discrete agent service calls
- [ ] Init script only does: mount, devices, hostname, network, secrets, agent, sshd, start.sh, zombie reaper
- [ ] `bun run typecheck` passes
- [ ] `cargo build --release --target x86_64-unknown-linux-musl` succeeds
- [ ] `bun run check` (Biome) passes

### Must Have
- Backward compatibility: agent gracefully handles old config format (services without command field = skip autostart, still allow port-only entries)
- Service env vars support (chromium needs `DISPLAY=:99`)
- Browser sequencing: xvfb → chromium → x11vnc → websockify (sequential start with health waits)

### Must NOT Have (Guardrails)
- No new Rust crates — `serde`, `serde_json`, `HashMap` already available
- No dynamic config reloading — config read once at startup
- No service dependency graph engine — browser sequencing is handled by manager calling starts in order
- No process restart policies / supervisor — keep it simple, agent just starts/stops
- No changes to vsock transport or HTTP protocol
- No test files (no test framework configured)

---

## Verification Strategy

### Test Decision
- **Infrastructure exists**: NO
- **User wants tests**: NO
- **QA approach**: Manual verification via build commands + runtime behavior

### Automated Verification (per task)
Each task specifies build verification commands. Runtime verification requires a running VM which is out of scope for automated checks — rely on build success + code review.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately):
├── Task 1: Shared schema (TypeScript)
└── Task 8: Init script cleanup (bash, independent)

Wave 2 (After Wave 1 — Task 1 must complete):
├── Task 2: Sandbox config schema (depends: 1)
├── Task 3: Agent config.rs (depends: 1 for shape knowledge)
├── Task 4: Agent services.rs + main.rs (depends: 3)
└── Task 5: Agent health.rs (depends: 3)

Wave 3 (After Wave 2):
├── Task 6: Provisioner (depends: 2)
├── Task 7: Browser routes (depends: 4, 6)
└── Task 9: Spawner update (depends: 4, 6)

Final: Task 10: Typecheck + Biome + Cargo build
```

### Dependency Matrix

| Task | Depends On | Blocks | Can Parallelize With |
|------|-----------|--------|---------------------|
| 1 | None | 2, 3, 4, 5, 6 | 8 |
| 2 | 1 | 6 | 3, 4, 5, 8 |
| 3 | 1 | 4, 5 | 2, 8 |
| 4 | 3 | 7, 9 | 2, 5, 8 |
| 5 | 3 | — | 2, 4, 8 |
| 6 | 2 | 7, 9 | 4, 5 |
| 7 | 4, 6 | 10 | 9 |
| 8 | None | — | 1, 2, 3, 4, 5 |
| 9 | 4, 6 | 10 | 7 |
| 10 | 7, 9 | — | — |

---

## TODOs

- [ ] 1. Extend shared `ServicesConfigSchema` with service definition fields

  **What to do**:
  - In `packages/shared/src/config.schema.ts`:
    - Create a new `SandboxServiceEntrySchema` (separate from the manager's `ServiceEntrySchema` which stays port-only for manager config):
      ```typescript
      export const SandboxServiceEntrySchema = Type.Object({
        port: Type.Optional(Type.Number()),
        command: Type.Optional(Type.String()),
        user: Type.Optional(Type.Union([Type.Literal("dev"), Type.Literal("root")])),
        autoStart: Type.Optional(Type.Boolean({ default: false })),
        env: Type.Optional(Type.Record(Type.String(), Type.String())),
        enabled: Type.Optional(Type.Boolean({ default: true })),
      });
      ```
    - Export the type: `export type SandboxServiceEntry = Static<typeof SandboxServiceEntrySchema>;`
    - The existing `ServiceEntrySchema` (port-only) and `ServicesConfigSchema` (fixed keys) remain unchanged — they're used for manager-side config (env vars, defaults). The new schema is for the VM-injected config.

  **Must NOT do**:
  - Do NOT modify existing `ServiceEntrySchema` or `ServicesConfigSchema` — those are manager config
  - Do NOT add `command`/`user`/`autoStart` to manager config schema

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]
    - `git-master`: Simple schema addition, one file

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 8)
  - **Blocks**: Tasks 2, 3
  - **Blocked By**: None

  **References**:
  - `packages/shared/src/config.schema.ts:102-121` — Existing `ServiceEntrySchema` and `ServicesConfigSchema` (keep these unchanged)
  - `packages/shared/src/sandbox-config.schema.ts:26` — Where `ServicesConfigSchema` is currently used (Task 2 will change this)

  **Acceptance Criteria**:
  - [ ] `SandboxServiceEntrySchema` and `SandboxServiceEntry` type exported from `config.schema.ts`
  - [ ] All fields are `Type.Optional` (backward compat with old configs)
  - [ ] Existing `ServiceEntrySchema`/`ServicesConfigSchema` untouched
  - [ ] `bun run typecheck` passes

  **Commit**: YES
  - Message: `feat(shared): add SandboxServiceEntry schema with command/user/autoStart/env`
  - Files: `packages/shared/src/config.schema.ts`

---

- [ ] 2. Update `SandboxConfigSchema` to use Record-based services

  **What to do**:
  - In `packages/shared/src/sandbox-config.schema.ts`:
    - Import `SandboxServiceEntrySchema` instead of `ServicesConfigSchema`
    - Change `services` field from `ServicesConfigSchema` (fixed keys) to `Type.Record(Type.String(), SandboxServiceEntrySchema)`
    - Update `SandboxConfig` type accordingly
  - This allows arbitrary service names (xvfb, chromium, x11vnc, websockify, etc.)

  **Must NOT do**:
  - Do NOT remove imports that other files may reference — check if `ServicesConfigSchema` is imported elsewhere

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES (within Wave 2)
  - **Parallel Group**: Wave 2 (with Tasks 3, 4, 5)
  - **Blocks**: Task 6
  - **Blocked By**: Task 1

  **References**:
  - `packages/shared/src/sandbox-config.schema.ts` — Full file (30 lines), line 9 imports `ServicesConfigSchema`, line 26 uses it
  - `packages/shared/src/config.schema.ts` — Where `SandboxServiceEntrySchema` will be (from Task 1)

  **Acceptance Criteria**:
  - [ ] `SandboxConfigSchema.services` is `Type.Record(Type.String(), SandboxServiceEntrySchema)`
  - [ ] `SandboxConfig` type resolves to `{ services: Record<string, SandboxServiceEntry> }`
  - [ ] `bun run typecheck` passes

  **Commit**: YES
  - Message: `feat(shared): make sandbox config services a dynamic Record`
  - Files: `packages/shared/src/sandbox-config.schema.ts`

---

- [ ] 3. Update Rust agent `config.rs` — HashMap-based services

  **What to do**:
  - In `apps/agent-rust/src/config.rs`:
    - Extend `ServiceConfig` struct:
      ```rust
      #[derive(Debug, Clone, Serialize, Deserialize)]
      #[serde(rename_all = "camelCase")]
      pub struct ServiceConfig {
          pub port: Option<u16>,
          pub command: Option<String>,
          pub user: Option<String>,
          #[serde(default)]
          pub auto_start: bool,
          #[serde(default)]
          pub env: Option<HashMap<String, String>>,
          #[serde(default)]
          pub enabled: Option<bool>,
      }
      ```
    - Replace `SandboxServices` fixed struct with:
      ```rust
      pub type SandboxServices = HashMap<String, ServiceConfig>;
      ```
    - Update `SandboxConfig.services` field type accordingly
    - Add `use std::collections::HashMap;` import
  - Note: `port` becomes `Option<u16>` because some services (like xvfb) have no port. `command` is `Option<String>` for port-only entries (like `browser`, `agent`).

  **Must NOT do**:
  - Do NOT add new crate dependencies
  - Do NOT change `SANDBOX_CONFIG` LazyLock pattern

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES (within Wave 2)
  - **Parallel Group**: Wave 2 (with Tasks 2, 4, 5)
  - **Blocks**: Tasks 4, 5
  - **Blocked By**: Task 1

  **References**:
  - `apps/agent-rust/src/config.rs:16-58` — Current `ServiceConfig` (port + enabled), `SandboxServices` (fixed fields), `SandboxConfig`
  - `apps/agent-rust/src/routes/services.rs:10` — Imports `SANDBOX_CONFIG` (will use new shape in Task 4)
  - `apps/agent-rust/src/routes/health.rs:7,100-106` — Imports and reads from fixed struct fields (Task 5 will update)

  **Acceptance Criteria**:
  - [ ] `ServiceConfig` has fields: `port: Option<u16>`, `command: Option<String>`, `user: Option<String>`, `auto_start: bool`, `env: Option<HashMap<String, String>>`, `enabled: Option<bool>`
  - [ ] `SandboxServices` is `HashMap<String, ServiceConfig>`
  - [ ] `SandboxConfig.services` field type is `SandboxServices`
  - [ ] `cargo check --target x86_64-unknown-linux-musl` passes (or `cargo check` if musl target not available locally — just verify compilation)

  **Commit**: YES
  - Message: `feat(agent): make ServiceConfig config-driven with HashMap services`
  - Files: `apps/agent-rust/src/config.rs`

---

- [ ] 4. Rewrite agent `services.rs` — config-driven + autoStart + env support

  **What to do**:
  This is the largest task. Rewrite `apps/agent-rust/src/routes/services.rs` to:

  **A) Remove all hardcoded definitions** (lines 15-111):
  - Delete `ServiceDef` struct
  - Delete `SERVICE_DEFS` static array
  - Delete `find_service_def()`, `get_workspace_dir()`, `get_dashboard_domain()`
  - Delete `code_server_port()`, `opencode_port()`, `ttyd_port()`
  - Delete `code_server_command()`, `opencode_command()`, `ttyd_command()`

  **B) Add config-driven lookup**:
  ```rust
  fn find_service_config(name: &str) -> Option<&ServiceConfig> {
      SANDBOX_CONFIG
          .as_ref()
          .and_then(|c| c.services.get(name))
  }
  ```

  **C) Replace `discover_running_services()` with `start_autostart_services()`**:
  ```rust
  pub async fn start_autostart_services() {
      let Some(cfg) = SANDBOX_CONFIG.as_ref() else { return };
      for (name, svc) in &cfg.services {
          if svc.auto_start && svc.command.is_some() {
              println!("Auto-starting service: {}", name);
              let _ = start_service_internal(name, svc).await;
          }
      }
  }
  ```

  **D) Extract shared start logic** into `start_service_internal(name, config)`:
  - Takes service name + `&ServiceConfig`
  - Builds command from `config.command`
  - Wraps with `su - {user} -c "..."` if `config.user == "dev"`
  - Sets environment variables from `config.env` using `cmd.envs()`
  - Spawns process, pumps logs, tracks in RUNNING_SERVICES
  - Returns `Result<ManagedService, String>` or similar

  **E) Update all handlers**:
  - `handle_service_start(name)`: Look up config via `find_service_config(name)`, call `start_service_internal`
  - `handle_services_list()`: Iterate `SANDBOX_CONFIG.services` keys instead of `SERVICE_DEFS`
  - `handle_service_status(name)`: Look up from config for port/defaults
  - `handle_service_stop(name)`: No changes needed (works on RUNNING_SERVICES map)
  - `handle_service_restart(name)`: No changes needed (calls stop then start)
  - `handle_service_logs(name)`: Change `find_service_def` check to `find_service_config` check

  **F) Update `main.rs`** (line 67-69):
  - Change `discover_running_services().await` to `start_autostart_services().await`

  **Must NOT do**:
  - Do NOT add service dependency/ordering logic — manager handles browser sequencing
  - Do NOT add restart policies or health checks
  - Do NOT change the HTTP response shapes (manager depends on them)
  - Do NOT change the process spawning pattern (sh -c, piped stdout/stderr, async log pump)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: none needed (Rust, follows existing patterns)

  **Parallelization**:
  - **Can Run In Parallel**: YES (within Wave 2, after Task 3)
  - **Parallel Group**: Wave 2 (sequential after Task 3)
  - **Blocks**: Tasks 7, 9
  - **Blocked By**: Task 3

  **References**:
  - `apps/agent-rust/src/routes/services.rs` — Full file (512 lines). Every line is relevant.
    - Lines 15-20: `ServiceDef` struct to delete
    - Lines 22-33: `ManagedService` struct — KEEP as-is
    - Lines 35-36: `RUNNING_SERVICES` — KEEP as-is
    - Lines 38-111: Hardcoded helpers + `SERVICE_DEFS` — DELETE all
    - Lines 117-150: `discover_running_services` — REPLACE with `start_autostart_services`
    - Lines 152-169: `find_pid_by_cmdline` — KEEP (useful for discover, but may not be needed if we remove discover; can remove)
    - Lines 171-202: `handle_services_list` — UPDATE to iterate config
    - Lines 204-230: `handle_service_status` — UPDATE lookup
    - Lines 232-362: `handle_service_start` — REFACTOR to use config lookup + extract `start_service_internal`
    - Lines 364-418: `handle_service_stop` — KEEP mostly unchanged
    - Lines 420-445: `handle_service_restart` — KEEP unchanged
    - Lines 447-511: `handle_service_logs` — UPDATE lookup check
  - `apps/agent-rust/src/config.rs` — New `ServiceConfig` shape (from Task 3)
  - `apps/agent-rust/src/main.rs:67-69` — Where `discover_running_services` is spawned
  - `apps/agent-rust/src/routes/dev.rs` — `is_process_running`, `pump_stream`, `signal_process` imports (keep using these)

  **Acceptance Criteria**:
  - [ ] No `SERVICE_DEFS`, `ServiceDef`, or hardcoded command functions remain
  - [ ] `find_service_config(name)` reads from `SANDBOX_CONFIG.services` HashMap
  - [ ] `start_autostart_services()` iterates config, starts services with `autoStart: true`
  - [ ] `handle_service_start` works for ANY service name defined in config (including xvfb, chromium, etc.)
  - [ ] Environment variables from `config.env` are set on spawned process
  - [ ] `main.rs` calls `start_autostart_services` instead of `discover_running_services`
  - [ ] `cargo check` passes

  **Commit**: YES
  - Message: `feat(agent): config-driven services with autoStart and env support`
  - Files: `apps/agent-rust/src/routes/services.rs`, `apps/agent-rust/src/main.rs`

---

- [ ] 5. Update agent `health.rs` — dynamic service port checking

  **What to do**:
  - In `apps/agent-rust/src/routes/health.rs`:
    - Replace hardcoded port reads (lines 103-106) with dynamic iteration over `SANDBOX_CONFIG.services`
    - Build the `"services"` JSON object dynamically:
      ```rust
      let cfg = SANDBOX_CONFIG.as_ref();
      let services_map = cfg.map(|c| &c.services);
      
      // Collect service names and ports for port checking
      let mut port_checks: Vec<(String, u16)> = Vec::new();
      if let Some(services) = services_map {
          for (name, svc) in services {
              if let Some(port) = svc.port {
                  port_checks.push((name.clone(), port));
              }
          }
      }
      // Always check sshd
      port_checks.push(("sshd".to_string(), 22));
      
      // spawn_blocking to check all ports
      // Build JSON: { "serviceName": true/false, ... }
      ```
    - Keep uptime, sandboxId in response
    - Keep `check_port_listening` function unchanged

  **Must NOT do**:
  - Do NOT change response structure fundamentally — manager reads `health.services` as `Record<string, boolean>`
  - Do NOT modify `handle_metrics` (unrelated)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES (within Wave 2)
  - **Parallel Group**: Wave 2 (with Tasks 2, 4)
  - **Blocks**: None
  - **Blocked By**: Task 3

  **References**:
  - `apps/agent-rust/src/routes/health.rs:97-135` — Current `handle_health` with hardcoded port reads
  - `apps/agent-rust/src/config.rs` — New `ServiceConfig` with `port: Option<u16>` (Task 3)
  - `apps/manager/src/api/sandbox.routes.ts:598-600` — Manager reads `health.services` as `Record<string, boolean>` — response shape must stay compatible

  **Acceptance Criteria**:
  - [ ] Health response `services` object has keys matching config service names (not hardcoded)
  - [ ] Services without ports are excluded from health check
  - [ ] `sshd` still checked at port 22 (hardcoded, not in config)
  - [ ] `cargo check` passes

  **Commit**: YES
  - Message: `feat(agent): dynamic health check from config service ports`
  - Files: `apps/agent-rust/src/routes/health.rs`

---

- [ ] 6. Update provisioner to build full service definitions

  **What to do**:
  - In `apps/manager/src/modules/sandbox/sandbox.provisioner.ts`, method `injectSandboxConfig` (line 134):
    - Import `SandboxConfig` from updated shared schema
    - Build full service entries with commands, users, autoStart, env:
      ```typescript
      const workspaceDir = /* existing logic lines 167-170 */;
      const dashboardDomain = config.domains.dashboard;
      
      services: {
        vscode: {
          port: config.raw.services.vscode.port,
          command: `/opt/shared/bin/code-server --bind-addr 0.0.0.0:${config.raw.services.vscode.port} --auth none --disable-telemetry ${workspaceDir}`,
          user: "dev",
          autoStart: true,
        },
        opencode: {
          port: config.raw.services.opencode.port,
          command: `cd ${workspaceDir} && /opt/shared/bin/opencode serve --hostname 0.0.0.0 --port ${config.raw.services.opencode.port} --cors https://${dashboardDomain}`,
          user: "dev",
          autoStart: true,
        },
        ttyd: {
          port: config.raw.services.terminal.port,
          command: `ttyd -p ${config.raw.services.terminal.port} -W -t fontSize=14 -t fontFamily=monospace su - dev`,
          user: "root",
          autoStart: true,
        },
        browser: {
          port: config.raw.services.browser.port,
        },
        xvfb: {
          command: "Xvfb :99 -screen 0 1280x900x24",
          user: "root",
          autoStart: false,
        },
        chromium: {
          command: `chromium --no-sandbox --disable-gpu --disable-software-rasterizer --disable-dev-shm-usage --window-size=1280,900 --start-maximized about:blank`,
          user: "dev",
          autoStart: false,
          env: { DISPLAY: ":99" },
        },
        x11vnc: {
          command: "x11vnc -display :99 -forever -shared -nopw -rfbport 5900",
          user: "root",
          autoStart: false,
        },
        websockify: {
          port: config.raw.services.browser.port,
          command: `websockify --web /opt/novnc ${config.raw.services.browser.port} localhost:5900`,
          user: "root",
          autoStart: false,
        },
        agent: {
          port: config.raw.services.agent.port,
        },
      }
      ```
    - Move `workspaceDir` computation (lines 167-170) BEFORE the config object so it can be used in command strings
    - The `satisfies SandboxConfig` check will validate against updated type
    - Remove `workspace-dir` file write (line 171) — no longer needed since commands are pre-built. BUT keep it for backward compat if init.sh still reads it. Actually, init.sh won't need it after cleanup. Remove it.

  **Must NOT do**:
  - Do NOT modify any other provisioner methods
  - Do NOT change the file path (`/etc/sandbox/config.json`)
  - Do NOT add workspace-specific browser URL resolution yet (use `about:blank` default)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: NO (needs Task 2 types)
  - **Parallel Group**: Wave 3 (with Tasks 7, 9)
  - **Blocks**: Tasks 7, 9
  - **Blocked By**: Task 2

  **References**:
  - `apps/manager/src/modules/sandbox/sandbox.provisioner.ts:134-172` — Current `injectSandboxConfig` method
  - `packages/shared/src/sandbox-config.schema.ts` — Updated `SandboxConfig` type (from Task 2)
  - `packages/shared/src/config.schema.ts` — Manager-side `ServicesConfigSchema` for reading port values
  - `apps/agent-rust/src/routes/services.rs:74-90` — Current command templates (reference for exact command strings)
  - `apps/manager/src/api/sandbox.routes.ts:617-625` — Current browser exec command (reference for xvfb/chromium/x11vnc/websockify commands)

  **Acceptance Criteria**:
  - [ ] Config.json written to VM includes full service entries with command/user/autoStart/env
  - [ ] vscode, opencode, ttyd have `autoStart: true`
  - [ ] Browser sub-services (xvfb, chromium, x11vnc, websockify) have `autoStart: false`
  - [ ] chromium has `env: { DISPLAY: ":99" }`
  - [ ] `satisfies SandboxConfig` type check passes
  - [ ] `bun run typecheck` passes

  **Commit**: YES
  - Message: `feat(manager): provisioner builds full config-driven service definitions`
  - Files: `apps/manager/src/modules/sandbox/sandbox.provisioner.ts`

---

- [ ] 7. Rewrite browser routes to use agent service endpoints

  **What to do**:
  - In `apps/manager/src/api/sandbox.routes.ts`, browser routes (lines 591-723):

  **Browser start** (`POST /:id/browser/start`, lines 591-655):
  - Remove the exec-based `browserCmd` shell script (lines 617-625)
  - Replace with sequential agent service starts:
    ```typescript
    // Start browser stack in sequence (order matters)
    await agentClient.serviceStart(sandbox.id, "xvfb");
    await new Promise(r => setTimeout(r, 300));  // Xvfb needs to be ready
    await agentClient.serviceStart(sandbox.id, "chromium");
    await new Promise(r => setTimeout(r, 500));  // Chromium needs display
    await agentClient.serviceStart(sandbox.id, "x11vnc");
    await new Promise(r => setTimeout(r, 200));
    await agentClient.serviceStart(sandbox.id, "websockify");
    ```
  - Keep the Caddy route registration (lines 636-641)
  - Keep the sandbox URL update (lines 642-647)
  - Remove the workspace/devCommands URL resolution logic (lines 607-615) — chromium URL is now baked into config as `about:blank`. Future: dynamic URL can be handled by a separate mechanism.

  **Browser stop** (`POST /:id/browser/stop`, lines 684-723):
  - Remove the exec-based `killCmd` (lines 691-697)
  - Replace with agent service stops (reverse order):
    ```typescript
    await Promise.all([
      agentClient.serviceStop(sandbox.id, "websockify").catch(() => {}),
      agentClient.serviceStop(sandbox.id, "x11vnc").catch(() => {}),
      agentClient.serviceStop(sandbox.id, "chromium").catch(() => {}),
      agentClient.serviceStop(sandbox.id, "xvfb").catch(() => {}),
    ]);
    ```
  - Keep Caddy route removal and URL cleanup

  **Browser status** (`GET /:id/browser/status`, lines 656-683):
  - Keep as-is — already uses health endpoint which will dynamically report websockify port

  **Must NOT do**:
  - Do NOT move Caddy route management to agent (needs host context)
  - Do NOT change response schemas (`BrowserStartResponseSchema`, etc.)
  - Do NOT add retry logic (keep it simple like current fire-and-forget)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES (within Wave 3, with Task 9)
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 10
  - **Blocked By**: Tasks 4, 6

  **References**:
  - `apps/manager/src/api/sandbox.routes.ts:591-723` — Current browser routes (full code)
  - `apps/manager/src/infrastructure/agent/agent.client.ts:301-313` — `serviceStart()` method signature
  - `apps/manager/src/infrastructure/agent/agent.client.ts` — Check if `serviceStop()` exists. If not, it needs to be added (POST `/services/{name}/stop`). Pattern identical to `serviceStart`.
  - `apps/agent-rust/src/router.rs` — Verify `/services/{name}/stop` endpoint is routed

  **Acceptance Criteria**:
  - [ ] Browser start calls `agentClient.serviceStart` for xvfb, chromium, x11vnc, websockify in sequence
  - [ ] Browser stop calls `agentClient.serviceStop` for all 4 services
  - [ ] No `agentClient.exec` calls remain in browser routes
  - [ ] Caddy route management unchanged
  - [ ] `agentClient.serviceStop` method exists (add if missing, same pattern as serviceStart)
  - [ ] `bun run typecheck` passes

  **Commit**: YES
  - Message: `feat(manager): browser routes use agent service start/stop instead of exec`
  - Files: `apps/manager/src/api/sandbox.routes.ts`, possibly `apps/manager/src/infrastructure/agent/agent.client.ts`

---

- [ ] 8. Strip init script to minimal

  **What to do**:
  - In `infra/images/dev-base/rootfs/etc/sandbox/sandbox-init.sh`:
  
  **KEEP** (lines 1-132):
  - PATH/HOME/BUN_INSTALL exports (lines 4-6)
  - Config/secrets/log vars (lines 8-13)
  - `log()` function (lines 15-17)
  - Mount filesystems (lines 22-30)
  - Read config values (lines 32-44) — keep for SANDBOX_ID used by hostname
  - Device nodes (lines 46-59)
  - Shared binaries mount (lines 61-69)
  - Hostname (lines 71-79)
  - /etc/hosts (lines 81-86)
  - Network setup (lines 88-95)
  - link_config helper (lines 97-105) — keep if used elsewhere
  - Secrets loading (lines 107-112)
  - Agent start (lines 114-122)
  - SSH daemon (lines 124-132)

  **KEEP** (lines 134-140):
  - Workspace dir read (lines 134-140) — still useful for start.sh

  **REMOVE** (lines 142-195):
  - Line 142: `SHARED_BIN="/opt/shared/bin"` — no longer needed
  - Lines 144-165: code-server start + extension install
  - Lines 167-177: OpenCode plugin SDK install
  - Lines 179-186: OpenCode start
  - Lines 188-195: ttyd start

  **KEEP** (lines 197-214):
  - start.sh execution (lines 197-201)
  - Log message (update to remove service ports listing)
  - Process listing (lines 207-208)
  - Zombie reaper (lines 210-214)

  **UPDATE**:
  - Line 204 log message: change from listing all service ports to just "SSH(22), agent($AGENT_PORT)"
  - Can simplify config reads (lines 35-44): only need SANDBOX_ID and AGENT_PORT now, remove VSCODE_PORT/OPENCODE_PORT/TERMINAL_PORT reads

  **Must NOT do**:
  - Do NOT remove mount, network, device, hostname, secrets, agent, sshd, start.sh, zombie reaper
  - Do NOT change the script's role as PID 1

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - `infra/images/dev-base/rootfs/etc/sandbox/sandbox-init.sh` — Full file (215 lines)
    - Lines 144-165: code-server + extensions to REMOVE
    - Lines 167-177: OpenCode plugin SDK to REMOVE
    - Lines 179-186: OpenCode to REMOVE
    - Lines 188-195: ttyd to REMOVE

  **Acceptance Criteria**:
  - [ ] No code-server, opencode, ttyd, extension install, or plugin SDK install in script
  - [ ] Script still mounts filesystems, sets up network, starts agent, starts sshd
  - [ ] start.sh still executed if present
  - [ ] Zombie reaper still runs
  - [ ] Script is valid bash (no syntax errors from removal)

  **Commit**: YES
  - Message: `refactor(init): strip service starts from init script (agent handles via config)`
  - Files: `infra/images/dev-base/rootfs/etc/sandbox/sandbox-init.sh`

---

- [ ] 9. Update spawner `reconfigureRestoredGuest` for config-driven services

  **What to do**:
  - In `apps/manager/src/orchestrators/sandbox-spawner.ts`, method `reconfigureRestoredGuest`:
    - The current code hardcodes `["code-server", "opencode", "ttyd"]` for service starts after restore
    - After this migration, the agent auto-starts services on boot. BUT for restored guests (snapshot resume), the agent is already running — it won't re-run autoStart.
    - Two options:
      1. Keep explicit service starts in spawner, but read service names from config instead of hardcoding
      2. Add an agent endpoint to trigger autoStart (e.g., POST /services/autostart-all)
    - **Go with option 1** (simpler, no agent changes):
      - Read service config to find services with `autoStart: true` and a `command`
      - Start those services via `agentClient.serviceStart`
    - Update service names: "code-server" → "vscode", "opencode" → "opencode", "ttyd" → "ttyd" (matching config keys)

  **Must NOT do**:
  - Do NOT add new agent endpoints for this
  - Do NOT change the fire-and-forget pattern

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: none

  **Parallelization**:
  - **Can Run In Parallel**: YES (within Wave 3, with Task 7)
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 10
  - **Blocked By**: Tasks 4, 6

  **References**:
  - `apps/manager/src/orchestrators/sandbox-spawner.ts` — `reconfigureRestoredGuest()` method, specifically the `serviceNames` array and `Promise.all` block
  - `packages/shared/src/sandbox-config.schema.ts` — `SandboxConfig` type for reading service config

  **Acceptance Criteria**:
  - [ ] No hardcoded service name array — reads from config or uses correct key names matching provisioner output
  - [ ] Service names match config keys: "vscode", "opencode", "ttyd"
  - [ ] `bun run typecheck` passes

  **Commit**: YES
  - Message: `fix(manager): spawner uses config-driven service names for restored guests`
  - Files: `apps/manager/src/orchestrators/sandbox-spawner.ts`

---

- [ ] 10. Final verification — typecheck + lint + cargo build

  **What to do**:
  - Run all verification commands:
    ```bash
    bun run typecheck        # TypeScript compilation
    bun run check            # Biome lint + format
    cargo check --target x86_64-unknown-linux-musl  # Rust compilation (or cargo check if no musl)
    ```
  - Fix any errors across all modified files
  - This is the integration check — all schema changes, agent changes, and manager changes must be consistent

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO (final task)
  - **Parallel Group**: Sequential (after Wave 3)
  - **Blocks**: None
  - **Blocked By**: Tasks 7, 9

  **References**:
  - All files modified in Tasks 1-9

  **Acceptance Criteria**:
  - [ ] `bun run typecheck` — 0 errors
  - [ ] `bun run check` — 0 errors (Biome)
  - [ ] `cargo check` — 0 errors (Rust)
  - [ ] No uncommitted changes remain

  **Commit**: YES (if any fixes needed)
  - Message: `fix: resolve typecheck/lint/build errors from config-driven migration`

---

## Commit Strategy

| After Task | Message | Key Files | Verification |
|------------|---------|-----------|--------------|
| 1 | `feat(shared): add SandboxServiceEntry schema` | config.schema.ts | typecheck |
| 2 | `feat(shared): sandbox config services as Record` | sandbox-config.schema.ts | typecheck |
| 3 | `feat(agent): HashMap-based ServiceConfig` | config.rs | cargo check |
| 4 | `feat(agent): config-driven services + autoStart` | services.rs, main.rs | cargo check |
| 5 | `feat(agent): dynamic health check from config` | health.rs | cargo check |
| 6 | `feat(manager): full service definitions in config` | provisioner.ts | typecheck |
| 7 | `feat(manager): browser routes via agent services` | sandbox.routes.ts | typecheck |
| 8 | `refactor(init): strip service starts from init` | sandbox-init.sh | bash -n |
| 9 | `fix(manager): config-driven service names in spawner` | sandbox-spawner.ts | typecheck |
| 10 | `fix: build verification` | any | all checks |

---

## Success Criteria

### Verification Commands
```bash
bun run typecheck     # Expected: 0 errors
bun run check         # Expected: 0 errors
cargo check           # Expected: 0 errors (in apps/agent-rust)
bash -n infra/images/dev-base/rootfs/etc/sandbox/sandbox-init.sh  # Expected: 0 errors
```

### Final Checklist
- [ ] No hardcoded service commands in agent (grep for "code-server" in services.rs = 0 hits)
- [ ] No `exec` calls in browser routes (grep for `.exec(` in browser section = 0 hits)
- [ ] No service starts in init.sh (grep for "code-server\|opencode\|ttyd" after agent start = 0 hits)
- [ ] Config.json shape includes command/user/autoStart for all services
- [ ] Agent reads and starts autoStart services on boot
- [ ] All build checks pass
