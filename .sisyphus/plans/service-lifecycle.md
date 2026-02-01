# Service Lifecycle Management: Agent-Owned Services

## TL;DR

> **Quick Summary**: Move service process ownership (start/stop/restart/status) from fragile manager-side pgrep+exec into the Rust agent. The agent already manages dev commands this way — generalize the pattern for system services (code-server, opencode, ttyd). sshd remains monitor-only.
>
> **Deliverables**:
> - New `services.rs` route module in agent with `/services/:name/start|stop|restart|status` + `/services` list
> - Updated manager `AgentClient` with service methods
> - Replaced `AgentOperations.services()` pgrep approach with agent native endpoint
> - Replaced spawner fire-and-forget exec with `/services/:name/start` calls
> - Updated TypeScript types and schemas for richer ServiceStatus
>
> **Estimated Effort**: Medium (3-4 hours)
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Task 1 (agent services.rs) → Task 3 (manager client) → Task 4 (spawner) → Task 5 (operations)

---

## Context

### Original Request
Refactor service monitoring and add restart capability. Move service lifecycle management INTO the Rust agent, replacing the fragile pgrep-based approach in the manager.

### Key Design Decisions
- **Mirror dev.rs pattern exactly**: Same ProcessStatus enum, HashMap tracking, spawn/signal/logs flow
- **Service definitions are hardcoded in agent**: The agent knows the 3 managed services and their commands via config.json
- **sshd is monitor-only**: Port check via health endpoint, no start/stop
- **`su - dev -c` for user services**: code-server and opencode run as `dev` user; ttyd runs as root
- **Discovery on boot**: Agent should discover already-running services (started by VM init scripts) by checking ports and finding PIDs
- **Keep /health as-is**: Port-based liveness checks remain the quick signal; `/services` gives detailed process info

### Dashboard Impact
The dashboard queries `GET /:id/services` which returns `{ services: [{ name, running, pid? }] }`. The new response will be a superset (adds status, port, startedAt, logFile) — backward compatible since `running` field is preserved.

---

## Work Objectives

### Core Objective
Agent owns all service processes, providing start/stop/restart/status/logs via HTTP endpoints. Manager delegates to agent instead of using exec+pgrep.

### Concrete Deliverables
- `apps/agent-rust/src/routes/services.rs` — New route module
- `apps/agent-rust/src/router.rs` — Add `/services` prefix routing
- `apps/agent-rust/src/routes/mod.rs` — Register services module
- `apps/manager/src/infrastructure/agent/agent.client.ts` — Add service methods
- `apps/manager/src/infrastructure/agent/agent.types.ts` — Richer ServiceStatus type
- `apps/manager/src/infrastructure/agent/agent.operations.ts` — Replace pgrep with agent call
- `apps/manager/src/orchestrators/sandbox-spawner.ts` — Replace fire-and-forget exec
- `apps/manager/src/schemas/sandbox.ts` — Update ServiceStatusSchema

### Definition of Done
- [ ] `cargo build --release --target x86_64-unknown-linux-musl` succeeds
- [ ] `bun run check` passes (Biome lint+format)
- [ ] `bun run typecheck` passes
- [ ] No pgrep-based service checks remain in agent.operations.ts
- [ ] No fire-and-forget service exec in sandbox-spawner.ts

### Must Have
- SIGTERM → configurable wait (500ms) → SIGKILL for stop/restart
- Process discovery on agent startup for init-script-launched services
- Log file routing to `/var/log/sandbox/{service-name}.log`
- Restart = stop + start (sequential, not concurrent)
- `su - dev -c "..."` wrapping for code-server and opencode

### Must NOT Have (Guardrails)
- Do NOT manage sshd lifecycle (monitor-only via port check)
- Do NOT add new external crates to Cargo.toml
- Do NOT change the /health endpoint response shape
- Do NOT modify dashboard code (response is backward-compatible superset)
- Do NOT add service auto-restart/watchdog logic (future scope)
- Do NOT extract shared code between dev.rs and services.rs into a common module (keep them independent, copy the pattern)

---

## Verification Strategy

### Test Decision
- **Infrastructure exists**: NO
- **User wants tests**: NO
- **QA approach**: Manual verification via build commands

### Automated Verification

```bash
# Rust agent compiles
cd apps/agent-rust && cargo check 2>&1 | tail -5
# Expected: no errors

# TypeScript type-checks
bun run typecheck
# Expected: exit 0

# Biome lint+format
bun run check
# Expected: exit 0
```

---

## Task Dependency Graph

| Task | Depends On | Reason |
|------|------------|--------|
| Task 1 | None | Agent services.rs is standalone Rust module |
| Task 2 | Task 1 | Router wiring needs the handlers from services.rs |
| Task 3 | None | TypeScript types/client can be written independently |
| Task 4 | Task 2, Task 3 | Spawner needs both agent endpoints AND client methods |
| Task 5 | Task 3 | Operations replacement needs client methods |
| Task 6 | Task 4, Task 5 | Final verification needs all changes in place |

## Parallel Execution Graph

```
Wave 1 (Start immediately):
├── Task 1: Agent services.rs (Rust module)
└── Task 3: Manager types + client + schema updates (TypeScript)

Wave 2 (After Wave 1):
├── Task 2: Agent router wiring (depends: Task 1)
├── Task 4: Spawner update (depends: Task 2, Task 3)
└── Task 5: Operations replacement (depends: Task 3)

Wave 3 (After Wave 2):
└── Task 6: Build verification + cleanup

Critical Path: Task 1 → Task 2 → Task 4
Parallel Speedup: ~30% faster than sequential
```

### Agent Dispatch Summary

| Wave | Tasks | Dispatch |
|------|-------|----------|
| 1 | 1, 3 | Parallel — independent languages/files |
| 2 | 2, 4, 5 | 2 first (quick), then 4+5 parallel |
| 3 | 6 | Sequential verification |

---

## TODOs

- [ ] 1. Create `apps/agent-rust/src/routes/services.rs`

  **What to do**:
  - Define `ServiceDef` struct: name, command template, user (dev/root), port, log_file
  - Define `MANAGED_SERVICES` constant array with 3 service definitions:
    - `code-server`: `/opt/shared/bin/code-server --bind-addr 0.0.0.0:{port} --auth none --disable-telemetry {workdir}`, user=dev, port from config
    - `opencode`: `cd {workdir} && /opt/shared/bin/opencode serve --hostname 0.0.0.0 --port {port} --cors https://{dashboard_domain}`, user=dev, port from config
    - `ttyd`: `ttyd -p {port} -W -t fontSize=14 -t fontFamily=monospace su - dev`, user=root, port from config
  - Define `ManagedService` struct (like DevProcess): name, status (Running/Stopped/Error), pid, port, started_at, exit_code, log_file
  - Define `RUNNING_SERVICES: LazyLock<Mutex<HashMap<String, ManagedService>>>`
  - Implement `discover_running_services()`: For each managed service, check if port is listening (reuse `check_port_listening` from health.rs — make it `pub`). If listening, find PID via `/proc/net/tcp` inode → `/proc/{pid}/fd` lookup OR simpler: read `/proc/*/cmdline` and match command name. Register discovered process into HashMap.
  - Call `discover_running_services()` from agent startup (main.rs, after vsock listener binds)
  - Implement `handle_services_list()` → GET /services: Return all services with current status (refresh is_process_running for each)
  - Implement `handle_service_status(name)` → GET /services/:name/status: Single service status
  - Implement `handle_service_start(name)` → POST /services/:name/start:
    - Look up ServiceDef by name, resolve command template with config values (ports, workdir, dashboard_domain from SANDBOX_CONFIG)
    - If user=dev: wrap command as `su - dev -c "{command}"`, spawn via `Command::new("/bin/sh").args(["-c", &wrapped])`
    - If user=root: spawn directly via `Command::new("/bin/sh").args(["-c", &command])`
    - Pipe stdout/stderr to log file at `/var/log/sandbox/{name}.log` (truncate on start, not append — fresh log per start)
    - Spawn background waiter task (same as dev.rs)
    - Insert into RUNNING_SERVICES HashMap
    - Return `{ status, pid, name, port, logFile, startedAt }`
  - Implement `handle_service_stop(name)` → POST /services/:name/stop:
    - SIGTERM → sleep 500ms → check alive → SIGKILL if needed
    - Update HashMap status
    - Return `{ status, name, pid, message }`
  - Implement `handle_service_restart(name)` → POST /services/:name/restart:
    - Call stop logic, then start logic sequentially
    - Return start result
  - Implement `handle_service_logs(name, query)` → GET /services/:name/logs:
    - Same as dev.rs handle_dev_logs (offset/limit pagination from log file)
  - For workspace dir resolution: Read first repo from `SANDBOX_CONFIG.repos[0].clone_path` prefixed with `/home/dev`, fallback to `/home/dev/workspace`
  - For dashboard domain: Read from `SANDBOX_CONFIG.network.dashboard_domain`

  **Must NOT do**:
  - Do NOT manage sshd (not in MANAGED_SERVICES)
  - Do NOT add auto-restart/watchdog
  - Do NOT add new crate dependencies
  - Do NOT extract shared code with dev.rs — copy the relevant patterns (is_process_running, signal_process, pump_stream are in dev.rs; either make them pub and import, or duplicate in services.rs — prefer making dev.rs helpers pub and importing them)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — Complex Rust module with process management, needs careful correctness
    - Reason: Non-trivial systems programming (signals, process discovery, /proc parsing)
  - **Skills**: [`git-master`]
    - `git-master`: Atomic commit after task completion

  **Skills Evaluated but Omitted**:
  - `typescript-programmer`: Not applicable — this is Rust
  - `frontend-ui-ux`: Not applicable
  - All others: No domain overlap with Rust systems programming

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 3)
  - **Parallel Group**: Wave 1
  - **Blocks**: Task 2 (router wiring)
  - **Blocked By**: None

  **References**:

  **Pattern References**:
  - `apps/agent-rust/src/routes/dev.rs:14-35` — ProcessStatus enum and DevProcess struct to mirror for ManagedService
  - `apps/agent-rust/src/routes/dev.rs:34-35` — RUNNING_DEV_COMMANDS LazyLock<Mutex<HashMap>> pattern to copy
  - `apps/agent-rust/src/routes/dev.rs:37-52` — is_process_running() and signal_process() helpers (make pub or copy)
  - `apps/agent-rust/src/routes/dev.rs:67-193` — handle_dev_start() spawn pattern: Command::new, pipe stdout/stderr, background waiter task
  - `apps/agent-rust/src/routes/dev.rs:195-212` — pump_stream() async log writer (make pub or copy)
  - `apps/agent-rust/src/routes/dev.rs:214-257` — handle_dev_stop() SIGTERM→SIGKILL pattern
  - `apps/agent-rust/src/routes/dev.rs:259-316` — handle_dev_logs() offset/limit log reader

  **Config References**:
  - `apps/agent-rust/src/config.rs:16-46` — SandboxConfig, SandboxServices, ServiceConfig structs with port fields
  - `apps/agent-rust/src/config.rs:61-65` — SANDBOX_CONFIG LazyLock loading
  - `apps/agent-rust/src/config.rs:5-6` — LOG_DIR and WORKSPACE_DIR constants

  **Health Reference** (for port checking):
  - `apps/agent-rust/src/routes/health.rs:12-35` — check_port_listening() reads /proc/net/tcp — make this `pub` for service discovery

  **Command templates** (from spawner, translate to Rust):
  - `apps/manager/src/orchestrators/sandbox-spawner.ts:471` — code-server command with setsid su wrapper
  - `apps/manager/src/orchestrators/sandbox-spawner.ts:472` — opencode command with cd + serve
  - `apps/manager/src/orchestrators/sandbox-spawner.ts:473` — ttyd command (runs as root)

  **Acceptance Criteria**:
  ```bash
  # Compiles without errors
  cd apps/agent-rust && cargo check 2>&1 | tail -3
  # Assert: "Finished" with no errors
  
  # Module is registered
  grep "pub mod services" apps/agent-rust/src/routes/mod.rs
  # Assert: line exists
  
  # All handlers exist
  grep -c "pub async fn handle_service" apps/agent-rust/src/routes/services.rs
  # Assert: ≥5 (list, status, start, stop, restart, logs)
  ```

  **Commit**: YES
  - Message: `feat(agent): add service lifecycle management endpoints`
  - Files: `apps/agent-rust/src/routes/services.rs`, `apps/agent-rust/src/routes/mod.rs`, `apps/agent-rust/src/routes/health.rs` (pub fn), `apps/agent-rust/src/routes/dev.rs` (pub helpers)
  - Pre-commit: `cd apps/agent-rust && cargo check`

---

- [ ] 2. Wire service routes in agent router

  **What to do**:
  - Add `/services` GET route to the match block in router.rs
  - Add `/services/` prefix matching (same pattern as `/dev/` block):
    - Strip prefix, splitn on '/'
    - `GET /services/:name/status` → handle_service_status
    - `POST /services/:name/start` → handle_service_start
    - `POST /services/:name/stop` → handle_service_stop
    - `POST /services/:name/restart` → handle_service_restart
    - `GET /services/:name/logs?offset=N&limit=N` → handle_service_logs
  - Add service discovery call in main.rs: After vsock listener is bound, call `routes::services::discover_running_services().await`

  **Must NOT do**:
  - Do NOT change existing route patterns
  - Do NOT modify the /health endpoint

  **Recommended Agent Profile**:
  - **Category**: `quick` — Small wiring changes to 2 files
  - **Skills**: [`git-master`]

  **Skills Evaluated but Omitted**:
  - All non-git skills: No domain overlap with router wiring

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2 (sequential after Task 1)
  - **Blocks**: Task 4
  - **Blocked By**: Task 1

  **References**:
  - `apps/agent-rust/src/router.rs:35-49` — Existing `/dev/` prefix routing pattern to mirror for `/services/`
  - `apps/agent-rust/src/router.rs:12-13` — Static route match pattern for `GET /services`
  - `apps/agent-rust/src/main.rs:1-88` — Startup sequence, add discover call after listener bind

  **Acceptance Criteria**:
  ```bash
  # Compiles
  cd apps/agent-rust && cargo check 2>&1 | tail -3
  # Assert: "Finished" with no errors
  
  # Routes are wired
  grep -c "services::" apps/agent-rust/src/router.rs
  # Assert: ≥6
  ```

  **Commit**: YES (group with Task 1)
  - Message: `feat(agent): wire service routes and boot discovery`
  - Files: `apps/agent-rust/src/router.rs`, `apps/agent-rust/src/main.rs`
  - Pre-commit: `cd apps/agent-rust && cargo check`

---

- [ ] 3. Update manager types, client methods, and schema

  **What to do**:
  - **agent.types.ts**: Enrich `ServiceStatus` interface:
    ```typescript
    export interface ServiceStatus {
      name: string;
      status: "running" | "stopped" | "error";
      running: boolean; // backward compat (derived from status)
      pid?: number;
      port?: number;
      startedAt?: string;
      exitCode?: number;
      logFile?: string;
    }
    ```
    Add new types:
    ```typescript
    export interface ServiceStartResult {
      status: string;
      pid?: number;
      name: string;
      port?: number;
      logFile?: string;
      startedAt?: string;
    }
    export interface ServiceStopResult {
      status: string;
      name: string;
      pid?: number;
      message?: string;
    }
    export interface ServiceListResult {
      services: ServiceStatus[];
    }
    ```
  - **agent.client.ts**: Add methods:
    - `serviceList(sandboxId): Promise<ServiceListResult>`  — GET /services
    - `serviceStatus(sandboxId, name): Promise<ServiceStatus>` — GET /services/:name/status
    - `serviceStart(sandboxId, name): Promise<ServiceStartResult>` — POST /services/:name/start
    - `serviceStop(sandboxId, name): Promise<ServiceStopResult>` — POST /services/:name/stop
    - `serviceRestart(sandboxId, name): Promise<ServiceStartResult>` — POST /services/:name/restart
    - `serviceLogs(sandboxId, name, offset, limit): Promise<DevLogsResult>` — GET /services/:name/logs (reuse DevLogsResult, same shape)
  - **schemas/sandbox.ts**: Update `ServiceStatusSchema` to include optional new fields (port, status string, startedAt, exitCode, logFile). Keep `running` as required boolean.

  **Must NOT do**:
  - Do NOT remove the `running` boolean from ServiceStatus (dashboard uses it)
  - Do NOT change method signatures of existing methods

  **Recommended Agent Profile**:
  - **Category**: `quick` — Straightforward type definitions and method additions
  - **Skills**: [`typescript-programmer`, `git-master`]
    - `typescript-programmer`: TypeScript interface definitions and Elysia patterns
    - `git-master`: Atomic commit

  **Skills Evaluated but Omitted**:
  - `frontend-ui-ux`: Not UI work
  - All others: No domain overlap

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 1)
  - **Parallel Group**: Wave 1
  - **Blocks**: Tasks 4, 5
  - **Blocked By**: None

  **References**:
  - `apps/manager/src/infrastructure/agent/agent.types.ts:26-30` — Current ServiceStatus to extend
  - `apps/manager/src/infrastructure/agent/agent.types.ts:87-121` — Dev* types as pattern for Service* types
  - `apps/manager/src/infrastructure/agent/agent.client.ts:255-292` — devList/devStart/devStop/devLogs methods to mirror for services
  - `apps/manager/src/schemas/sandbox.ts:108-118` — ServiceStatusSchema and ServicesResponseSchema to update

  **Acceptance Criteria**:
  ```bash
  bun run typecheck
  # Assert: exit 0
  
  bun run check
  # Assert: exit 0
  
  grep "serviceStart" apps/manager/src/infrastructure/agent/agent.client.ts
  # Assert: method exists
  ```

  **Commit**: YES
  - Message: `feat(manager): add agent service lifecycle client methods and types`
  - Files: `apps/manager/src/infrastructure/agent/agent.types.ts`, `apps/manager/src/infrastructure/agent/agent.client.ts`, `apps/manager/src/schemas/sandbox.ts`
  - Pre-commit: `bun run typecheck && bun run check`

---

- [ ] 4. Replace spawner fire-and-forget exec with service start calls

  **What to do**:
  - In `sandbox-spawner.ts` `reconfigureRestoredGuest()` (lines 461-488):
    - Remove the `servicesCmd` string concatenation and `agentClient.exec()` fire-and-forget
    - Replace with sequential agent service start calls:
      ```typescript
      // Start services via agent (non-blocking, don't await all)
      const serviceNames = ["code-server", "opencode", "ttyd"];
      Promise.all(
        serviceNames.map((name) =>
          this.deps.agentClient.serviceStart(this.sandboxId, name).catch((err) => {
            log.warn(
              { sandboxId: this.sandboxId, service: name, error: String(err) },
              "Service start failed (non-blocking)",
            );
          })
        )
      ).catch(() => {});
      ```
    - Keep the fire-and-forget semantics (Promise.all without await, .catch at end)
    - Remove the `workspaceDir`, `dashboardDomain`, port variable declarations that were only used for the old servicesCmd (lines 461-468) — BUT check if they're used elsewhere in the method first. If they are, keep them.

  **Must NOT do**:
  - Do NOT change network reconfiguration logic (lines 418-435)
  - Do NOT change mount logic (lines 437-455)
  - Do NOT change pushAuthAndConfigs() call (line 459)
  - Do NOT await the service starts (keep non-blocking)

  **Recommended Agent Profile**:
  - **Category**: `quick` — Replace ~20 lines with ~15 lines
  - **Skills**: [`typescript-programmer`, `git-master`]

  **Skills Evaluated but Omitted**:
  - All non-TS/git skills: No domain overlap

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 5, after Tasks 2+3)
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 6
  - **Blocked By**: Tasks 2, 3

  **References**:
  - `apps/manager/src/orchestrators/sandbox-spawner.ts:461-488` — The exact fire-and-forget block to replace
  - `apps/manager/src/orchestrators/sandbox-spawner.ts:418-460` — Surrounding context (don't touch)

  **Acceptance Criteria**:
  ```bash
  bun run typecheck
  # Assert: exit 0
  
  # No more setsid/pgrep in spawner service launch
  grep -c "setsid" apps/manager/src/orchestrators/sandbox-spawner.ts
  # Assert: 0 (the setsid lines are removed)
  
  # Uses agent service start
  grep "serviceStart" apps/manager/src/orchestrators/sandbox-spawner.ts
  # Assert: exists
  ```

  **Commit**: YES
  - Message: `refactor(spawner): use agent service endpoints instead of fire-and-forget exec`
  - Files: `apps/manager/src/orchestrators/sandbox-spawner.ts`
  - Pre-commit: `bun run typecheck && bun run check`

---

- [ ] 5. Replace AgentOperations.services() pgrep with agent call

  **What to do**:
  - In `agent.operations.ts`, replace `services()` method (lines 38-58):
    ```typescript
    async services(sandboxId: string): Promise<{ services: ServiceStatus[] }> {
      return this.client.serviceList(sandboxId);
    }
    ```
  - Update the import if `ServiceStatus` type moved or changed
  - The `logs()` method (line 60+) can stay as-is for now OR be updated to use `/services/:name/logs` — check if it currently uses `tail -n` via exec. If so, update to use `this.client.serviceLogs()` for system services, keep exec-based for other log files.

  **Must NOT do**:
  - Do NOT change other methods in AgentOperations (git*, resizeStorage, etc.)

  **Recommended Agent Profile**:
  - **Category**: `quick` — Replace one method body
  - **Skills**: [`typescript-programmer`, `git-master`]

  **Skills Evaluated but Omitted**:
  - All non-TS/git: No overlap

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 4)
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 6
  - **Blocked By**: Task 3

  **References**:
  - `apps/manager/src/infrastructure/agent/agent.operations.ts:38-58` — The pgrep-based services() to replace
  - `apps/manager/src/infrastructure/agent/agent.operations.ts:60-80` — The logs() method (check if should also update)

  **Acceptance Criteria**:
  ```bash
  bun run typecheck
  # Assert: exit 0
  
  # No more pgrep in operations
  grep "pgrep" apps/manager/src/infrastructure/agent/agent.operations.ts
  # Assert: no matches
  
  # Uses serviceList
  grep "serviceList" apps/manager/src/infrastructure/agent/agent.operations.ts
  # Assert: exists
  ```

  **Commit**: YES
  - Message: `refactor(operations): replace pgrep service checks with agent endpoints`
  - Files: `apps/manager/src/infrastructure/agent/agent.operations.ts`
  - Pre-commit: `bun run typecheck && bun run check`

---

- [ ] 6. Final build verification and cleanup

  **What to do**:
  - Run full Rust build: `cd apps/agent-rust && cargo check`
  - Run TypeScript typecheck: `bun run typecheck`
  - Run Biome: `bun run check`
  - Verify no stale references to pgrep service pattern
  - Verify no unused imports

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: [`git-master`]

  **Parallelization**:
  - **Can Run In Parallel**: NO (final verification)
  - **Parallel Group**: Wave 3
  - **Blocks**: None
  - **Blocked By**: Tasks 4, 5

  **References**:
  - Root `package.json` for `check` and `typecheck` scripts

  **Acceptance Criteria**:
  ```bash
  cd apps/agent-rust && cargo check 2>&1 | tail -3
  # Assert: success
  
  bun run typecheck
  # Assert: exit 0
  
  bun run check
  # Assert: exit 0
  
  grep -r "pgrep" apps/manager/src/
  # Assert: no matches in agent-related files
  ```

  **Commit**: NO (verification only, previous tasks committed individually)

---

## Commit Strategy

| After Task | Message | Files | Verification |
|------------|---------|-------|--------------|
| 1+2 | `feat(agent): add service lifecycle management with routes` | services.rs, mod.rs, health.rs, dev.rs, router.rs, main.rs | `cargo check` |
| 3 | `feat(manager): add agent service lifecycle client methods` | agent.types.ts, agent.client.ts, schemas/sandbox.ts | `bun run typecheck` |
| 4 | `refactor(spawner): use agent service endpoints` | sandbox-spawner.ts | `bun run typecheck` |
| 5 | `refactor(operations): replace pgrep with agent endpoints` | agent.operations.ts | `bun run typecheck` |

---

## Success Criteria

### Verification Commands
```bash
cd apps/agent-rust && cargo check    # Rust compiles
bun run typecheck                     # TS compiles
bun run check                        # Biome passes
grep -r "pgrep" apps/manager/src/    # No pgrep service checks
```

### Final Checklist
- [ ] Agent has /services/:name/start|stop|restart|status|logs endpoints
- [ ] Agent discovers running services on boot
- [ ] Manager client has serviceList/serviceStart/serviceStop/serviceRestart/serviceLogs methods
- [ ] Spawner uses serviceStart instead of exec
- [ ] Operations uses serviceList instead of pgrep+batchExec
- [ ] Dashboard response remains backward-compatible (running boolean preserved)
- [ ] No new crate dependencies added
- [ ] sshd is NOT managed, only monitored via /health
