//! Interactive terminal sessions. A terminal is an *ad-hoc* `pty: true`
//! process the user opens on demand: `POST /terminal/sessions` spawns
//! `bash -l` on a fresh PTY and registers it in the attach registry
//! (attach.rs), which pumps its output to a replay buffer and any number of
//! WS clients. Those join on the attach port at `/terminal/{sessionId}`:
//! binary frames are keystrokes, text frames are `{"type":"resize"}` controls
//! (applied via `TIOCSWINSZ`).
//!
//! This module owns only what is terminal-specific: the session list and
//! cap, the spawn, and the resize control frame.
//!
//! Sessions persist across WS disconnects (reconnect replays scrollback and
//! resumes the same shell) and die only on explicit `DELETE`, on shell exit,
//! or with the pod. A per-sandbox cap bounds how many shells can be spawned.

use std::collections::HashMap;
use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tokio::io::unix::AsyncFd;
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::attach::{AttachRegistry, PtyMaster, setup_pty, terminal_key};
use crate::limits::DEFAULT_LOG_DIR;
use crate::logfile::LogFile;
use crate::store::ConfigStore;

/// Per-sandbox ceiling on concurrent shells — a soft guard against a client
/// (or a loop) spawning unbounded PTYs.
const MAX_TERMINALS: usize = 8;
const SHELL_USER: &str = "dev";
const SHELL_HOME: &str = "/home/dev";

/// The shell's environment in application order (a later entry wins): the
/// caller's per-session env (client hints such as `COLORTERM`; the agent
/// assumes nothing about the terminal emulator), then the pod-wide env, then
/// the terminal type and identity the shell must have.
fn shell_env(
    session_env: HashMap<String, String>,
    pod_env: HashMap<String, String>,
) -> Vec<(String, String)> {
    let fixed = [
        ("TERM", "xterm-256color"),
        ("HOME", SHELL_HOME),
        ("USER", SHELL_USER),
    ]
    .map(|(k, v)| (k.to_string(), v.to_string()));
    session_env
        .into_iter()
        .chain(pod_env)
        .chain(fixed)
        .collect()
}

/// The wire shape the runtime expects (`TerminalSession` in
/// apps/server/src/runtime/agent/agent.types.ts).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMeta {
    pub id: String,
    pub user_id: String,
    pub title: String,
    pub created_at: String,
}

/// Create-request body (`{ userId, title?, command?, workdir?, env? }`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    pub user_id: String,
    pub title: Option<String>,
    pub command: Option<String>,
    pub workdir: Option<String>,
    /// Extra env for this session (the console's terminal capability hints).
    #[serde(default)]
    pub env: HashMap<String, String>,
}

/// A resize control frame sent as WS text by xterm.js.
#[derive(Deserialize)]
struct ResizeFrame {
    #[serde(rename = "type")]
    kind: String,
    cols: u16,
    rows: u16,
}

/// One live shell: its metadata, the PTY master (resize target) and the pgid
/// used to reap the whole tree on delete. Output and input run through the
/// attach registry's endpoint for `terminal_key(id)`.
struct Terminal {
    meta: TerminalMeta,
    master: Arc<AsyncFd<PtyMaster>>,
    pgid: i32,
}

pub struct TerminalRegistry {
    sessions: Mutex<HashMap<String, Arc<Terminal>>>,
    counter: AtomicU64,
    store: Arc<ConfigStore>,
    attach: Arc<AttachRegistry>,
    log_dir: String,
}

impl TerminalRegistry {
    pub fn new(store: Arc<ConfigStore>, attach: Arc<AttachRegistry>) -> Arc<Self> {
        let log_dir =
            std::env::var("ATELIER_LOG_DIR").unwrap_or_else(|_| DEFAULT_LOG_DIR.to_string());
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
            store,
            attach,
            log_dir,
        })
    }

    /// Spawn a login shell on a new PTY. Errors if the sandbox is at its
    /// terminal cap or the PTY/child fails to start.
    pub async fn create(self: &Arc<Self>, req: CreateRequest) -> Result<TerminalMeta, String> {
        {
            let sessions = self.sessions.lock().await;
            if sessions.len() >= MAX_TERMINALS {
                return Err(format!("terminal limit reached ({MAX_TERMINALS})"));
            }
        }

        let n = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
        let id = format!("term-{n}");
        let created_at = crate::now_rfc3339();

        // A login shell by default; an explicit command runs under `-l -c`.
        let mut cmd = Command::new("/bin/bash");
        match req.command.as_deref().filter(|c| !c.trim().is_empty()) {
            Some(command) => {
                cmd.args(["-l", "-c", command]);
            }
            None => {
                cmd.args(["-l", "-i"]);
            }
        }
        // NB: no `process_group(0)` here — setup_pty's `setsid()` already starts a
        // new session + process group (EPERM otherwise, since a group leader
        // can't setsid). The shell becomes its own group leader, so its pid is
        // the pgid we signal on delete.
        cmd.envs(shell_env(
            req.env,
            self.store.get().map(|c| c.env.clone()).unwrap_or_default(),
        ));
        cmd.current_dir(req.workdir.as_deref().unwrap_or(SHELL_HOME));

        // uid drop to `dev` happens inside setup_pty's pre_exec (after TIOCSCTTY).
        let (master, slave) =
            setup_pty(&mut cmd, Some(SHELL_USER)).map_err(|e| format!("setup pty: {e}"))?;
        let child = cmd.spawn().map_err(|e| format!("spawn shell: {e}"))?;
        // Close the parent's slave copy now the child has inherited it.
        drop(slave);
        let pgid = child.id().unwrap_or(0) as i32;

        let log = self.open_log(&id).await;
        self.attach
            .register_pty(&terminal_key(&id), master.clone(), log)
            .await;

        let meta = TerminalMeta {
            id: id.clone(),
            user_id: req.user_id,
            title: req.title.unwrap_or_else(|| "Terminal".to_string()),
            created_at,
        };
        let terminal = Arc::new(Terminal {
            meta: meta.clone(),
            master,
            pgid,
        });
        self.sessions.lock().await.insert(id.clone(), terminal);

        // Reaper: when the shell exits (user typed `exit`, or DELETE killed it),
        // drop the session so it stops showing up and its fds close.
        let registry = self.clone();
        tokio::spawn(async move {
            let mut child = child;
            let _ = child.wait().await;
            registry.remove(&id).await;
        });

        Ok(meta)
    }

    pub async fn list(&self) -> Vec<TerminalMeta> {
        self.sessions
            .lock()
            .await
            .values()
            .map(|t| t.meta.clone())
            .collect()
    }

    pub async fn get(&self, id: &str) -> Option<TerminalMeta> {
        self.sessions.lock().await.get(id).map(|t| t.meta.clone())
    }

    /// Kill the shell's process group and forget the session. Idempotent: the
    /// reaper also removes on exit.
    pub async fn delete(&self, id: &str) -> bool {
        let Some(terminal) = self.sessions.lock().await.remove(id) else {
            return false;
        };
        if terminal.pgid > 0 {
            // SAFETY: negative pid signals the whole process group.
            unsafe { libc::kill(-terminal.pgid, libc::SIGKILL) };
        }
        self.attach.remove(&terminal_key(id)).await;
        true
    }

    async fn remove(&self, id: &str) {
        self.sessions.lock().await.remove(id);
        self.attach.remove(&terminal_key(id)).await;
    }

    /// The session's PTY master, for the attach WS to apply resize frames to.
    pub async fn master(&self, id: &str) -> Option<Arc<AsyncFd<PtyMaster>>> {
        self.sessions.lock().await.get(id).map(|t| t.master.clone())
    }

    async fn open_log(&self, id: &str) -> Arc<LogFile> {
        let _ = tokio::fs::create_dir_all(&self.log_dir).await;
        let path = format!("{}/{id}.log", self.log_dir);
        // A log open failure must not sink the terminal; fall back to /dev/null.
        match LogFile::open(&path).await {
            Ok(log) => log,
            Err(_) => LogFile::open("/dev/null").await.expect("open /dev/null"),
        }
    }
}

/// Apply a WS text control frame (`{"type":"resize","cols":..,"rows":..}`) to
/// the terminal's PTY; anything else is ignored.
pub fn apply_control_frame(master: &AsyncFd<PtyMaster>, text: &[u8]) {
    if let Ok(frame) = serde_json::from_slice::<ResizeFrame>(text)
        && frame.kind == "resize"
    {
        set_winsize(master, frame.cols, frame.rows);
    }
}

fn set_winsize(master: &AsyncFd<PtyMaster>, cols: u16, rows: u16) {
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: TIOCSWINSZ reads a winsize through the pointer; fd is owned.
    unsafe {
        libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ, &ws as *const _);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Resolve like `Command::envs` does: the last entry for a key wins.
    fn resolved(session: &[(&str, &str)], pod: &[(&str, &str)]) -> HashMap<String, String> {
        let to_map = |pairs: &[(&str, &str)]| -> HashMap<String, String> {
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        shell_env(to_map(session), to_map(pod))
            .into_iter()
            .collect()
    }

    #[test]
    fn assumes_no_terminal_capabilities_of_its_own() {
        let env = resolved(&[], &[]);
        assert_eq!(env["TERM"], "xterm-256color");
        assert!(!env.contains_key("COLORTERM"));
        assert!(!env.contains_key("PI_HYPERLINKS"));
    }

    #[test]
    fn session_env_applies_and_pod_env_overrides_it() {
        let env = resolved(
            &[("COLORTERM", "truecolor"), ("FOO", "session")],
            &[("FOO", "pod"), ("BAR", "bar")],
        );
        assert_eq!(env["COLORTERM"], "truecolor");
        assert_eq!(env["FOO"], "pod");
        assert_eq!(env["BAR"], "bar");
    }

    #[test]
    fn shell_identity_is_not_overridable() {
        let env = resolved(
            &[("TERM", "vt52")],
            &[("TERM", "dumb"), ("HOME", "/root"), ("USER", "root")],
        );
        assert_eq!(env["TERM"], "xterm-256color");
        assert_eq!(env["HOME"], SHELL_HOME);
        assert_eq!(env["USER"], SHELL_USER);
    }

    #[test]
    fn create_request_env_is_optional() {
        let req: CreateRequest = serde_json::from_str(r#"{"userId":"u"}"#).unwrap();
        assert!(req.env.is_empty());
        let req: CreateRequest =
            serde_json::from_str(r#"{"userId":"u","env":{"COLORTERM":"truecolor"}}"#).unwrap();
        assert_eq!(req.env["COLORTERM"], "truecolor");
    }
}
