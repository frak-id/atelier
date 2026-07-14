//! Interactive terminal sessions. Where the attach bridge (attach.rs) exposes
//! a *supervised* process's stdio/PTY, a terminal is an *ad-hoc* login shell
//! the user opens on demand: `POST /terminal/sessions` spawns `bash -l` on a
//! fresh PTY, and a WS
//! on port 7681 (`/{sessionId}`) relays bytes both ways plus `{"type":"resize"}`
//! control frames (applied via `TIOCSWINSZ`).
//!
//! Sessions persist across WS disconnects (reconnect replays scrollback and
//! resumes the same shell) and die only on explicit `DELETE`, on shell exit,
//! or with the pod. A per-sandbox cap bounds how many shells can be spawned.
//!
//! Self-contained on purpose: it reuses only the PTY primitives from attach.rs
//! (`setup_pty`, `PtyMaster`, `pty_read`, `pty_write`) and the replay buffer
//! from bridge.rs, leaving the supervised-attach path untouched. The framing
//! differs anyway — here text frames are resize control, not raw input.

use std::collections::HashMap;
use std::os::fd::AsRawFd;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use futures_util::{SinkExt, StreamExt};
use hyper::body::Bytes;
use serde::{Deserialize, Serialize};
use tokio::io::unix::AsyncFd;
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;
use tokio::sync::{Mutex, broadcast, mpsc};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

use crate::attach::{PtyMaster, pty_read, pty_write, setup_pty};
use crate::bridge::OutputBuffer;
use crate::store::ConfigStore;

pub const TERMINAL_PORT: u16 = 7681;

/// Per-sandbox ceiling on concurrent shells — a soft guard against a client
/// (or a loop) spawning unbounded PTYs.
const MAX_TERMINALS: usize = 8;
const READ_BUFFER_SIZE: usize = 16 * 1024;
const OUTPUT_BROADCAST_CAPACITY: usize = 256;
const WRITE_CHANNEL_CAPACITY: usize = 64;
const DEFAULT_LOG_DIR: &str = "/var/log/sandbox";
const SHELL_USER: &str = "dev";
const SHELL_HOME: &str = "/home/dev";

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

/// Create-request body (`{ userId, title?, command?, workdir? }`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRequest {
    pub user_id: String,
    pub title: Option<String>,
    pub command: Option<String>,
    pub workdir: Option<String>,
}

/// A resize control frame sent as WS text by xterm.js.
#[derive(Deserialize)]
struct ResizeFrame {
    #[serde(rename = "type")]
    kind: String,
    cols: u16,
    rows: u16,
}

/// One live shell: the PTY master (output pump + resize target), a broadcast
/// of its output with a replay buffer, a write sink into the master, and the
/// pgid used to reap the whole tree on delete.
struct Terminal {
    meta: TerminalMeta,
    master: Arc<AsyncFd<PtyMaster>>,
    output: broadcast::Sender<Bytes>,
    buffer: Arc<Mutex<OutputBuffer>>,
    write_tx: mpsc::Sender<Vec<u8>>,
    pgid: i32,
}

pub struct TerminalRegistry {
    sessions: Mutex<HashMap<String, Arc<Terminal>>>,
    counter: AtomicU64,
    store: Arc<ConfigStore>,
    log_dir: String,
}

impl TerminalRegistry {
    pub fn new(store: Arc<ConfigStore>) -> Arc<Self> {
        let log_dir =
            std::env::var("ATELIER_LOG_DIR").unwrap_or_else(|_| DEFAULT_LOG_DIR.to_string());
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            counter: AtomicU64::new(0),
            store,
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
        // Pod-wide env, then terminal-friendly defaults the shell expects.
        for (k, v) in self.store.get().map(|c| c.env.clone()).unwrap_or_default() {
            cmd.env(k, v);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("HOME", SHELL_HOME);
        cmd.env("USER", SHELL_USER);
        cmd.current_dir(req.workdir.as_deref().unwrap_or(SHELL_HOME));

        // uid drop to `dev` happens inside setup_pty's pre_exec (after TIOCSCTTY).
        let (master, slave) =
            setup_pty(&mut cmd, Some(SHELL_USER)).map_err(|e| format!("setup pty: {e}"))?;
        let child = cmd.spawn().map_err(|e| format!("spawn shell: {e}"))?;
        // Close the parent's slave copy now the child has inherited it.
        drop(slave);
        let pgid = child.id().unwrap_or(0) as i32;

        let log = self.open_log(&id).await;
        let (output, _) = broadcast::channel(OUTPUT_BROADCAST_CAPACITY);
        let buffer = Arc::new(Mutex::new(OutputBuffer::default()));
        let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>(WRITE_CHANNEL_CAPACITY);

        tokio::spawn(pump_pty(
            master.clone(),
            output.clone(),
            buffer.clone(),
            log,
        ));
        tokio::spawn(drain_to_pty(master.clone(), write_rx));

        let meta = TerminalMeta {
            id: id.clone(),
            user_id: req.user_id,
            title: req.title.unwrap_or_else(|| "Terminal".to_string()),
            created_at,
        };
        let terminal = Arc::new(Terminal {
            meta: meta.clone(),
            master,
            output,
            buffer,
            write_tx,
            pgid,
        });
        self.sessions
            .lock()
            .await
            .insert(id.clone(), terminal.clone());

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
        true
    }

    async fn remove(&self, id: &str) {
        self.sessions.lock().await.remove(id);
    }

    async fn lookup(&self, id: &str) -> Option<Arc<Terminal>> {
        self.sessions.lock().await.get(id).cloned()
    }

    async fn open_log(&self, id: &str) -> Arc<Mutex<tokio::fs::File>> {
        let _ = tokio::fs::create_dir_all(&self.log_dir).await;
        let path = format!("{}/{id}.log", self.log_dir);
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await;
        // A log open failure must not sink the terminal; fall back to /dev/null.
        let file = match file {
            Ok(f) => f,
            Err(_) => tokio::fs::OpenOptions::new()
                .write(true)
                .open("/dev/null")
                .await
                .expect("open /dev/null"),
        };
        Arc::new(Mutex::new(file))
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

async fn pump_pty(
    master: Arc<AsyncFd<PtyMaster>>,
    output: broadcast::Sender<Bytes>,
    buffer: Arc<Mutex<OutputBuffer>>,
    log: Arc<Mutex<tokio::fs::File>>,
) {
    use tokio::io::AsyncWriteExt;
    let mut buf = [0u8; READ_BUFFER_SIZE];
    loop {
        let Ok(mut guard) = master.readable().await else {
            break;
        };
        match guard.try_io(|inner| pty_read(inner.as_raw_fd(), &mut buf)) {
            Ok(Ok(0)) | Ok(Err(_)) => break,
            Ok(Ok(n)) => {
                let bytes = Bytes::copy_from_slice(&buf[..n]);
                let _ = log.lock().await.write_all(&buf[..n]).await;
                buffer.lock().await.push(bytes.clone());
                let _ = output.send(bytes);
            }
            Err(_would_block) => continue,
        }
    }
}

async fn drain_to_pty(master: Arc<AsyncFd<PtyMaster>>, mut rx: mpsc::Receiver<Vec<u8>>) {
    while let Some(data) = rx.recv().await {
        let mut written = 0;
        while written < data.len() {
            let Ok(mut guard) = master.writable().await else {
                return;
            };
            match guard.try_io(|inner| pty_write(inner.as_raw_fd(), &data[written..])) {
                Ok(Ok(0)) | Ok(Err(_)) => return,
                Ok(Ok(n)) => written += n,
                Err(_would_block) => continue,
            }
        }
    }
}

// ── WebSocket server ─────────────────────────────────────────────────────────

/// Terminal WS listener on its own port so the runtime proxies
/// `WS /sandboxes/:id/terminal/sessions/:sid/ws` straight through. The request
/// target is `/{sessionId}` (see `TerminalService.bridgeUrl`).
pub async fn serve(port: u16, registry: Arc<TerminalRegistry>) {
    let Ok(listener) = TcpListener::bind(("0.0.0.0", port)).await else {
        eprintln!("terminal: failed to bind port {port}");
        return;
    };
    println!("terminal: WebSocket server listening on port {port}");
    while let Ok((stream, _addr)) = listener.accept().await {
        let mut peek = [0u8; 1024];
        let Ok(n) = stream.peek(&mut peek).await else {
            continue;
        };
        let Some(id) = parse_session_id(&peek[..n]) else {
            continue;
        };
        let registry = registry.clone();
        tokio::spawn(async move {
            handle_conn(stream, id, registry).await;
        });
    }
}

/// Pull the session id out of the WS upgrade request line
/// (`GET /{sessionId} HTTP/1.1`). Strips any query string.
fn parse_session_id(buf: &[u8]) -> Option<String> {
    let request = String::from_utf8_lossy(buf);
    let target = request.lines().next()?.split_whitespace().nth(1)?;
    let path = target.strip_prefix('/')?;
    let id = path.split('?').next().unwrap_or(path);
    if id.is_empty() || id.contains('/') {
        return None;
    }
    Some(id.to_string())
}

async fn handle_conn(stream: TcpStream, id: String, registry: Arc<TerminalRegistry>) {
    let Some(terminal) = registry.lookup(&id).await else {
        return;
    };
    let Ok(ws) = accept_async(stream).await else {
        return;
    };
    let (mut sink, mut source) = ws.split();

    // Replay scrollback, then subscribe to live output.
    let (chunks, mut rx) = {
        let chunks = terminal.buffer.lock().await.snapshot_chunks();
        (chunks, terminal.output.subscribe())
    };
    for chunk in chunks {
        if sink.send(Message::Binary(chunk.to_vec())).await.is_err() {
            return;
        }
    }

    let mut out_task = tokio::spawn(async move {
        // recv() errors on Closed (shell gone) or Lagged (this client fell
        // behind); either way stop, so a lagged client reconnects and replays
        // rather than render a gapped stream.
        while let Ok(data) = rx.recv().await {
            if sink.send(Message::Binary(data.to_vec())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let write_tx = terminal.write_tx.clone();
    let master = terminal.master.clone();
    let mut in_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = source.next().await {
            match msg {
                // Bytes are keystrokes into the shell.
                Message::Binary(b) => {
                    if write_tx.send(b).await.is_err() {
                        break;
                    }
                }
                // Text is a resize control frame; anything else is ignored.
                Message::Text(t) => {
                    if let Ok(frame) = serde_json::from_slice::<ResizeFrame>(t.as_bytes())
                        && frame.kind == "resize"
                    {
                        set_winsize(&master, frame.cols, frame.rows);
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = &mut out_task => in_task.abort(),
        _ = &mut in_task => out_task.abort(),
    }
}
