//! Process supervisor — the v2 replacement for v1's manager-driven
//! `POST /services/{name}/start`. The agent now owns the process lifecycle:
//! it reconciles running processes against the pushed config, spawns non-lazy
//! processes at boot respecting `after` ordering, latches per-process
//! readiness (config.rs probes), enforces restart policy, and reports the
//! `primary` process's readiness as the sandbox's health.
//!
//! Ported and reshaped from apps/agent-rust process_manager.rs: the pgid group
//! spawn + SIGTERM/SIGKILL teardown + log pumping are kept; the manager-poll
//! model is replaced by config-watch reconcile + agent-side readiness.

use std::collections::HashMap;
use std::io::SeekFrom;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{Mutex, Notify};

use crate::attach::{self, AttachRegistry};
use crate::config::{AgentConfig, ProcessEntry, Readiness, StdioMode, http_probe_url};
use crate::readiness::{self, ProbeCtx};
use crate::store::ConfigStore;

const DEFAULT_LOG_DIR: &str = "/var/log/sandbox";
const STOP_GRACE_MS: u64 = 5000;
/// Fallback re-check cadence for an `after` wait; a `Notify` wakes it the
/// instant any process latches ready, so this only bounds terminal/timeout
/// re-checks.
const AFTER_POLL_MS: u64 = 250;
/// Self-probe cadence while waiting for a process's own readiness to latch.
/// Tighter than the after fallback because the primary-ready signal boot gates
/// on rides on it (a probe is a cheap loopback connect / tiny GET).
const READINESS_PROBE_MS: u64 = 100;
/// Bound on how long an `after` dependency's readiness is awaited before the
/// dependent spawns anyway (a never-ready dep must not wedge boot forever).
const AFTER_WAIT_TIMEOUT: Duration = Duration::from_secs(120);
/// Backoff between restarts so a crash-looping process can't peg a core.
const RESTART_BACKOFF: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsResult {
    pub name: String,
    pub content: String,
    pub next_offset: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessStatus {
    Starting,
    Running,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessState {
    pub name: String,
    pub status: ProcessStatus,
    pub pid: u32,
    pub ready: bool,
    pub primary: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub started_at: String,
    pub log_file: String,
    /// Bumped on every (re)spawn; the wait-task from an older generation drops
    /// its restart decision so a config swap or manual restart can't double-run.
    #[serde(skip)]
    pub generation: u64,
}

pub struct Supervisor {
    store: Arc<ConfigStore>,
    procs: Arc<Mutex<HashMap<String, ProcessState>>>,
    log_dir: String,
    /// Attach endpoints for `stdio: bridge` / `pty` processes (attach.rs).
    attach: Arc<AttachRegistry>,
    /// Woken whenever a process latches ready, so `after` waits react
    /// immediately instead of polling out their fallback interval.
    ready_notify: Notify,
    /// Globally monotonic instance id. Every spawn takes a fresh value; a
    /// watcher acts only while the entry still carries its value, so a stopped
    /// or superseded instance can never alias a live one.
    gen_counter: AtomicU64,
}

impl Supervisor {
    pub fn new(store: Arc<ConfigStore>) -> Arc<Self> {
        // ATELIER_LOG_DIR overrides the per-process log directory (an agent
        // operational path, not sandbox content) for local runs / tests.
        let log_dir =
            std::env::var("ATELIER_LOG_DIR").unwrap_or_else(|_| DEFAULT_LOG_DIR.to_string());
        Self::with_log_dir(store, log_dir)
    }

    fn with_log_dir(store: Arc<ConfigStore>, log_dir: String) -> Arc<Self> {
        Arc::new(Self {
            store,
            procs: Arc::new(Mutex::new(HashMap::new())),
            log_dir,
            attach: AttachRegistry::new(),
            ready_notify: Notify::new(),
            gen_counter: AtomicU64::new(0),
        })
    }

    /// The attach registry, so `main` can serve the attach WS endpoint.
    pub fn attach_registry(&self) -> Arc<AttachRegistry> {
        self.attach.clone()
    }

    fn log_file(&self, name: &str) -> String {
        format!("{}/{name}.log", self.log_dir)
    }

    fn next_generation(&self) -> u64 {
        self.gen_counter.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Bring running processes in line with the current config: start every
    /// non-lazy process that isn't already running. (Removing processes
    /// dropped from config is a later concern — boot only ever adds.)
    pub async fn reconcile(self: &Arc<Self>) {
        let Some(cfg) = self.store.get() else { return };
        for p in &cfg.processes {
            if p.lazy {
                continue;
            }
            if self.is_active(&p.name).await {
                continue;
            }
            let this = self.clone();
            let name = p.name.clone();
            // Spawn per-process so `after` waits run concurrently, not serially.
            tokio::spawn(async move {
                if let Err(e) = this.start(&name).await {
                    eprintln!("supervisor: failed to start {name}: {e}");
                }
            });
        }
    }

    /// Ensure a (possibly lazy) process is running — used for socket-activation
    /// style lazy spawn and explicit start requests.
    pub async fn ensure_started(self: &Arc<Self>, name: &str) -> Result<(), String> {
        if self.is_active(name).await {
            return Ok(());
        }
        self.start(name).await
    }

    async fn is_active(&self, name: &str) -> bool {
        let procs = self.procs.lock().await;
        procs
            .get(name)
            .is_some_and(|p| matches!(p.status, ProcessStatus::Starting | ProcessStatus::Running))
    }

    /// Resolve, await `after` deps' readiness, spawn, then wire readiness +
    /// restart watchers.
    async fn start(self: &Arc<Self>, name: &str) -> Result<(), String> {
        let Some(cfg) = self.store.get() else {
            return Err("no config".into());
        };
        let Some(process) = cfg.processes.iter().find(|p| p.name == name).cloned() else {
            return Err(format!("unknown process: {name}"));
        };

        // Claim this start with a fresh generation and a Starting sentinel so
        // concurrent reconciles don't double-spawn; the generation lets us
        // detect a stop/supersede that lands during the `after` wait.
        let generation = self.next_generation();
        {
            let mut procs = self.procs.lock().await;
            if let Some(existing) = procs.get(name)
                && matches!(
                    existing.status,
                    ProcessStatus::Starting | ProcessStatus::Running
                )
            {
                return Ok(());
            }
            procs.insert(
                name.to_string(),
                ProcessState {
                    name: name.to_string(),
                    status: ProcessStatus::Starting,
                    pid: 0,
                    ready: false,
                    primary: process.primary,
                    exit_code: None,
                    started_at: String::new(),
                    log_file: self.log_file(name),
                    generation,
                },
            );
        }

        self.await_after_deps(&process).await;
        match self.spawn(process, cfg, generation).await {
            Ok(()) => Ok(()),
            Err(e) => {
                // Don't leave the Starting sentinel wedged (is_active would skip
                // it forever); mark it Error so a later reconcile can retry.
                let mut procs = self.procs.lock().await;
                if let Some(entry) = procs.get_mut(name)
                    && entry.generation == generation
                {
                    entry.status = ProcessStatus::Error;
                }
                Err(e)
            }
        }
    }

    /// Block until every `after` dependency has latched ready, or the bound
    /// elapses (then proceed with a warning rather than wedging boot).
    async fn await_after_deps(&self, process: &ProcessEntry) {
        if process.after.is_empty() {
            return;
        }
        let deadline = tokio::time::Instant::now() + AFTER_WAIT_TIMEOUT;
        for dep in &process.after {
            loop {
                // Register for the wakeup *before* checking so a ready-latch
                // between the check and the wait can't be lost.
                let notified = self.ready_notify.notified();
                if self.is_ready(dep).await {
                    break;
                }
                // A dep that already exited will never become ready; stop waiting.
                if self.is_terminal(dep).await {
                    eprintln!(
                        "supervisor: {}'s dependency {dep} exited before readiness",
                        process.name
                    );
                    break;
                }
                if tokio::time::Instant::now() >= deadline {
                    eprintln!(
                        "supervisor: {} timed out waiting for {dep} readiness; starting anyway",
                        process.name
                    );
                    break;
                }
                // Woken early by any ready-latch, else re-checks on the fallback.
                let _ = tokio::time::timeout(Duration::from_millis(AFTER_POLL_MS), notified).await;
            }
        }
    }

    async fn spawn(
        self: &Arc<Self>,
        process: ProcessEntry,
        cfg: Arc<AgentConfig>,
        generation: u64,
    ) -> Result<(), String> {
        let log_file = self.log_file(&process.name);
        let _ = tokio::fs::create_dir_all(&self.log_dir).await;
        let log_handle = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_file)
            .await
            .map_err(|e| format!("open log {log_file}: {e}"))?;

        // Attach mode selects how stdio is wired: PTY (terminal), stdio-bridge
        // (relay stdin/stdout over WS), or none (pipe to the log only).
        let is_pty = process.pty;
        let is_bridge = !is_pty && process.stdio == StdioMode::Bridge;

        let mut cmd = Command::new("/bin/bash");
        cmd.args(["-l", "-c", &process.command])
            // pgid = child pid so kill(-pgid) reaps the whole tree.
            .process_group(0);
        if is_bridge {
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
        } else if !is_pty {
            cmd.stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
        }
        // PTY sets uid inside pre_exec (after TIOCSCTTY); others use CommandExt.
        if !is_pty {
            apply_user(&mut cmd, process.user.as_deref().unwrap_or("root"));
        }
        // Pod-wide env first, then per-process env (process wins).
        for (k, v) in &cfg.env {
            cmd.env(k, v);
        }
        for (k, v) in process.env.iter().flatten() {
            cmd.env(k, v);
        }
        if let Some(dir) = &process.cwd {
            cmd.current_dir(dir);
        }

        let pty_master = if is_pty {
            Some(
                attach::setup_pty(&mut cmd, process.user.as_deref())
                    .map_err(|e| format!("setup pty for {}: {e}", process.name))?,
            )
        } else {
            None
        };

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("spawn {}: {e}", process.name))?;
        let pid = child.id().unwrap_or(0);

        // Commit only if this start still owns the entry. A stop() or a newer
        // start() during the `after` wait bumps the generation; if so, this
        // instance is orphaned — kill its group and reap it, don't track it.
        {
            let mut procs = self.procs.lock().await;
            match procs.get_mut(&process.name) {
                Some(entry) if entry.generation == generation => {
                    entry.pid = pid;
                    entry.status = ProcessStatus::Running;
                    entry.ready = false;
                    entry.exit_code = None;
                    entry.started_at = crate::now_rfc3339();
                }
                _ => {
                    drop(procs);
                    signal_group(pid, libc::SIGKILL);
                    tokio::spawn(async move {
                        let _ = child.wait().await;
                    });
                    return Ok(());
                }
            }
        }

        // Wire stdio to the attach bridge (bridge/pty) or the log (none).
        let log_wr = Arc::new(Mutex::new(log_handle));
        if let Some(master) = pty_master {
            self.attach
                .register_pty(&process.name, master, log_wr)
                .await;
        } else if is_bridge {
            let stdin = child.stdin.take();
            let stdout = child.stdout.take();
            if let (Some(stdin), Some(stdout)) = (stdin, stdout) {
                self.attach
                    .register_bridge(&process.name, stdin, stdout, log_wr.clone())
                    .await;
            }
            if let Some(err) = child.stderr.take() {
                spawn_log_pump(err, log_wr);
            }
        } else {
            if let Some(out) = child.stdout.take() {
                spawn_log_pump(out, log_wr.clone());
            }
            if let Some(err) = child.stderr.take() {
                spawn_log_pump(err, log_wr);
            }
        }

        // Readiness watcher: latch ready once the probe passes (or immediately
        // if the process declares none — liveness == started).
        self.spawn_readiness_watch(&process, &cfg, generation);
        // Restart watcher: await exit, apply policy for this generation.
        self.spawn_wait_watch(child, process, generation);
        Ok(())
    }

    fn spawn_readiness_watch(
        self: &Arc<Self>,
        process: &ProcessEntry,
        cfg: &Arc<AgentConfig>,
        generation: u64,
    ) {
        let this = self.clone();
        let name = process.name.clone();
        let readiness = process.readiness.clone();
        let http_url = match &process.readiness {
            Some(Readiness::Http { http }) => http_probe_url(http, &name, &cfg.ports),
            _ => None,
        };
        let ctx = ProbeCtx {
            user: process.user.clone(),
            cwd: process.cwd.clone(),
            env: cfg
                .env
                .iter()
                .chain(process.env.iter().flatten())
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        };
        tokio::spawn(async move {
            let Some(readiness) = readiness else {
                this.mark_ready(&name, generation).await;
                return;
            };
            loop {
                // Bail if this instance was replaced/stopped (a stale watcher
                // must never latch a newer generation as ready).
                if this.current_generation(&name).await != Some(generation) {
                    return;
                }
                if this.is_terminal(&name).await {
                    return;
                }
                if readiness::probe(&readiness, http_url.as_deref(), &ctx).await {
                    this.mark_ready(&name, generation).await;
                    return;
                }
                tokio::time::sleep(Duration::from_millis(READINESS_PROBE_MS)).await;
            }
        });
    }

    fn spawn_wait_watch(
        self: &Arc<Self>,
        mut child: tokio::process::Child,
        process: ProcessEntry,
        generation: u64,
    ) {
        let this = self.clone();
        tokio::spawn(async move {
            let status = child.wait().await;
            let code = status.ok().and_then(|s| s.code());
            let restart = {
                let mut procs = this.procs.lock().await;
                let Some(entry) = procs.get_mut(&process.name) else {
                    return;
                };
                // A newer generation already replaced this process; ignore.
                if entry.generation != generation {
                    return;
                }
                entry.exit_code = code;
                entry.ready = false;
                let clean = code == Some(0);
                entry.status = if clean {
                    ProcessStatus::Stopped
                } else {
                    ProcessStatus::Error
                };
                should_restart(process.restart, clean)
            };
            // The exited process's attach endpoint is dead; a restart will
            // register a fresh one, so drop it either way.
            this.attach.remove(&process.name).await;
            if restart {
                tokio::time::sleep(RESTART_BACKOFF).await;
                // Restart through start() (not spawn()): it re-runs the
                // `after` wait and re-guards against a concurrent reconcile,
                // and only if this instance still owns the entry.
                if this.current_generation(&process.name).await == Some(generation)
                    && let Err(e) = this.start(&process.name).await
                {
                    eprintln!("supervisor: restart of {} failed: {e}", process.name);
                }
            }
        });
    }

    async fn mark_ready(&self, name: &str, generation: u64) {
        {
            let mut procs = self.procs.lock().await;
            let Some(entry) = procs.get_mut(name) else {
                return;
            };
            if entry.generation != generation || !matches!(entry.status, ProcessStatus::Running) {
                return;
            }
            entry.ready = true;
        }
        // Wake any `after` waits gated on this process.
        self.ready_notify.notify_waiters();
    }

    async fn is_ready(&self, name: &str) -> bool {
        self.procs.lock().await.get(name).is_some_and(|p| p.ready)
    }

    async fn is_terminal(&self, name: &str) -> bool {
        self.procs
            .lock()
            .await
            .get(name)
            .is_some_and(|p| matches!(p.status, ProcessStatus::Stopped | ProcessStatus::Error))
    }

    async fn current_generation(&self, name: &str) -> Option<u64> {
        self.procs.lock().await.get(name).map(|p| p.generation)
    }

    /// Sandbox health: the `primary` process's readiness. With no primary,
    /// the sandbox is healthy as soon as the agent is up (nothing gates it).
    pub async fn is_healthy(&self) -> bool {
        // Consult the config, not just tracked procs: between a config push (or
        // a `reconcile` that spawns the primary asynchronously) and the primary
        // actually entering `procs`, a tracked-only check would find no primary
        // and wrongly report healthy — opening the runtime's boot gate before
        // the primary is up.
        let primary = self.store.get().and_then(|cfg| {
            cfg.processes
                .iter()
                .find(|p| p.primary)
                .map(|p| p.name.clone())
        });
        match primary {
            Some(name) => self.procs.lock().await.get(&name).is_some_and(|p| p.ready),
            None => true,
        }
    }

    pub async fn list(&self) -> Vec<ProcessState> {
        self.procs.lock().await.values().cloned().collect()
    }

    pub async fn get(&self, name: &str) -> Option<ProcessState> {
        self.procs.lock().await.get(name).cloned()
    }

    /// Read a byte window of a process's combined stdout/stderr log. `offset`
    /// is a byte cursor and `next_offset` in the result lets a caller poll for
    /// more without re-reading (a missing log file reads as empty, not error,
    /// so logs are queryable before/after the process has ever run).
    pub async fn read_logs(&self, name: &str, offset: u64, limit: usize) -> LogsResult {
        // Seek to `offset` and read at most `limit` bytes so a chatty process's
        // huge log never gets slurped whole into memory (allocation is bounded
        // by `limit`, which the router caps). A missing file / seek past EOF
        // reads as empty, leaving `next_offset` where the caller asked.
        let mut buf = Vec::new();
        if let Ok(mut file) = tokio::fs::File::open(self.log_file(name)).await
            && file.seek(SeekFrom::Start(offset)).await.is_ok()
        {
            let _ = file.take(limit as u64).read_to_end(&mut buf).await;
        }
        LogsResult {
            name: name.to_string(),
            next_offset: offset + buf.len() as u64,
            content: String::from_utf8_lossy(&buf).into_owned(),
        }
    }

    /// SIGTERM the group, escalate to SIGKILL after the grace window, and mark
    /// the process stopped so `never`-restart policy leaves it down.
    pub async fn stop(&self, name: &str) -> Result<(), String> {
        let pid = {
            let mut procs = self.procs.lock().await;
            let Some(entry) = procs.get_mut(name) else {
                return Err(format!("unknown process: {name}"));
            };
            // Fresh generation so the pending wait-watch (and any in-flight
            // start) sees itself superseded and won't restart/commit.
            entry.generation = self.next_generation();
            entry.status = ProcessStatus::Stopped;
            entry.ready = false;
            entry.pid
        };
        if pid > 1 {
            signal_group(pid, libc::SIGTERM);
            let deadline = tokio::time::Instant::now() + Duration::from_millis(STOP_GRACE_MS);
            // Probe *group* liveness, not the leader pid: the wait-watch reaps
            // the child, after which the bare pid could be recycled by an
            // unrelated process and wrongly keep us polling / draw a SIGKILL.
            while tokio::time::Instant::now() < deadline {
                if !is_group_alive(pid) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            if is_group_alive(pid) {
                signal_group(pid, libc::SIGKILL);
            }
        }
        self.attach.remove(name).await;
        Ok(())
    }
}

/// Apply the uid/env for a known principal. Today only `dev` (uid 1000) is
/// special-cased (v1 parity); anything else runs as the agent's uid (root).
pub(crate) fn apply_user(cmd: &mut Command, user: &str) {
    if user == "dev" {
        cmd.uid(1000).gid(1000);
        cmd.env("HOME", "/home/dev");
        cmd.env("USER", "dev");
    }
}

fn should_restart(policy: crate::config::RestartPolicy, clean_exit: bool) -> bool {
    use crate::config::RestartPolicy::*;
    match policy {
        Never => false,
        OnFailure => !clean_exit,
        Always => true,
    }
}

fn spawn_log_pump<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
    mut reader: R,
    writer: Arc<Mutex<tokio::fs::File>>,
) {
    tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = writer.lock().await.write_all(&buf[..n]).await;
                }
            }
        }
    });
}

/// True while any process in the group is still alive (pgid == leader pid,
/// set via `process_group(0)` at spawn). Group ids aren't recycled while a
/// member lives, so this is safe against leader-pid reuse after reaping.
fn is_group_alive(pgid: u32) -> bool {
    if pgid <= 1 {
        return false;
    }
    // SAFETY: signal 0 only probes existence; negative target = the group.
    unsafe { libc::kill(-(pgid as i32), 0) == 0 }
}

fn signal_group(pgid: u32, signal: i32) {
    if pgid <= 1 {
        return;
    }
    // SAFETY: pgid validated > 1; the negative target signals the group.
    unsafe { libc::kill(-(pgid as i32), signal) };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Hooks;

    fn base_cfg() -> AgentConfig {
        AgentConfig {
            sandbox_id: "sb".into(),
            env: HashMap::new(),
            processes: vec![],
            ports: vec![],
            hooks: Hooks::default(),
        }
    }

    fn proc(name: &str, command: &str) -> ProcessEntry {
        ProcessEntry {
            name: name.into(),
            command: command.into(),
            cwd: None,
            env: None,
            user: None,
            primary: false,
            stdio: crate::config::StdioMode::None,
            pty: false,
            readiness: None,
            after: vec![],
            restart: crate::config::RestartPolicy::Never,
            lazy: false,
        }
    }

    #[test]
    fn restart_policy_matrix() {
        use crate::config::RestartPolicy::*;
        assert!(!should_restart(Never, false));
        assert!(!should_restart(OnFailure, true));
        assert!(should_restart(OnFailure, false));
        assert!(should_restart(Always, true));
        assert!(should_restart(Always, false));
    }

    fn test_supervisor(cfg: AgentConfig) -> Arc<Supervisor> {
        let store = Arc::new(ConfigStore::new_for_test(Some(cfg)));
        let dir = std::env::temp_dir().join(format!("atelier-agent-test-{}", std::process::id()));
        Supervisor::with_log_dir(store, dir.to_string_lossy().into_owned())
    }

    #[tokio::test]
    async fn healthy_without_primary() {
        let sup = test_supervisor(base_cfg());
        assert!(sup.is_healthy().await);
    }

    #[tokio::test]
    async fn autostart_runs_non_lazy_and_latches_ready() {
        let mut cfg = base_cfg();
        cfg.processes = vec![proc("touch", "echo hi"), {
            let mut p = proc("lazy", "echo no");
            p.lazy = true;
            p
        }];
        let sup = test_supervisor(cfg);
        sup.reconcile().await;
        // Give the spawned tasks a moment to run the short commands.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let touch = sup.get("touch").await.expect("touch tracked");
        // No readiness probe → ready latched at spawn; short command then exits.
        assert!(touch.ready || touch.status == ProcessStatus::Stopped);
        assert!(sup.get("lazy").await.is_none(), "lazy must not autostart");
    }

    #[tokio::test]
    async fn on_failure_restarts_then_stops_when_stopped() {
        let mut cfg = base_cfg();
        let mut p = proc("flap", "exit 1");
        p.restart = crate::config::RestartPolicy::OnFailure;
        cfg.processes = vec![p];
        let sup = test_supervisor(cfg);
        sup.reconcile().await;
        // It exits 1, backs off (500ms), restarts through start() at least once.
        // Poll up to ~3s so the assertion isn't wedged to a fixed sleep under
        // parallel-test CPU contention.
        let mut restarted = false;
        for _ in 0..30 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if sup.get("flap").await.is_some_and(|s| s.generation >= 2) {
                restarted = true;
                break;
            }
        }
        assert!(restarted, "on-failure should have restarted at least once");
        // An explicit stop supersedes the restart loop: it settles Stopped.
        sup.stop("flap").await.expect("stop");
        tokio::time::sleep(Duration::from_millis(900)).await;
        let state = sup.get("flap").await.expect("tracked");
        assert_eq!(state.status, ProcessStatus::Stopped);
    }

    #[tokio::test]
    async fn primary_gates_health_until_ready() {
        let mut cfg = base_cfg();
        // A primary that stays up but has a port probe that never binds:
        // health stays false.
        let mut p = proc("prim", "sleep 5");
        p.primary = true;
        p.readiness = Some(Readiness::Port { port: 1 });
        cfg.processes = vec![p];
        let sup = test_supervisor(cfg);
        sup.reconcile().await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!sup.is_healthy().await, "primary not ready → unhealthy");
    }

    #[tokio::test]
    async fn read_logs_windows_and_tolerates_missing() {
        let sup = test_supervisor(base_cfg());
        // Missing log file reads as empty (queryable before first run).
        let empty = sup.read_logs("never-ran", 0, 100).await;
        assert_eq!(empty.content, "");
        assert_eq!(empty.next_offset, 0);

        tokio::fs::create_dir_all(&sup.log_dir).await.unwrap();
        tokio::fs::write(sup.log_file("p"), b"hello world")
            .await
            .unwrap();
        let head = sup.read_logs("p", 0, 5).await;
        assert_eq!(head.content, "hello");
        assert_eq!(head.next_offset, 5);
        let tail = sup.read_logs("p", head.next_offset, 100).await;
        assert_eq!(tail.content, " world");
        assert_eq!(tail.next_offset, 11);
        // Offset past EOF is clamped, not a panic.
        assert_eq!(sup.read_logs("p", 999, 100).await.content, "");
    }
}
