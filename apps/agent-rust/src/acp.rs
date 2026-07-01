//! ACP (Agent Client Protocol) stdio <-> WebSocket bridge.
//!
//! An ACP harness (e.g. `opencode acp`, `claude-agent-acp`, `pi-acp`) speaks
//! newline-delimited JSON-RPC over stdio. The manager is remote, so we spawn the
//! harness per session and relay its stdio over a WebSocket. The relay is a
//! transparent byte pump — it never parses or rewrites the JSON-RPC, so protocol
//! version negotiation stays end-to-end between the manager and the harness.
//!
//! This mirrors `terminal.rs`, but uses piped stdio instead of a PTY: child
//! stdout fans out to WS clients (with replay of recent output to late joiners),
//! and WS input is written to child stdin.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Request, Response, StatusCode};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, mpsc, Mutex, RwLock};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

use crate::body::{read_body_limited, ReadBodyError};
use crate::bridge::{generate_session_id, parse_session_id_from_request, OutputBuffer};
use crate::config::{get_config, ServiceConfig, LOG_DIR};
use crate::limits::MAX_REQUEST_BODY_BYTES;
use crate::response::{json_error, json_ok};
use crate::routes::process_manager::signal_group;
use crate::utc_rfc3339;

const READ_BUFFER_SIZE: usize = 16 * 1024;
const OUTPUT_BROADCAST_CAPACITY: usize = 256;
const WRITE_CHANNEL_CAPACITY: usize = 64;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSessionInfo {
    pub id: String,
    pub pid: u32,
    pub created_at: String,
}

/// All fields are immutable after construction or internally synchronized
/// (`broadcast`/`mpsc` senders are `Clone + Sync`), so no per-session lock is
/// needed — only the `OutputBuffer` has its own short-lived mutex.
struct AcpSession {
    info: AcpSessionInfo,
    buffer: Arc<Mutex<OutputBuffer>>,
    output_broadcast: broadcast::Sender<Bytes>,
    write_tx: mpsc::Sender<Vec<u8>>,
}

struct AcpState {
    port: u16,
    sessions: HashMap<String, Arc<AcpSession>>,
}

static ACP_STATE: std::sync::LazyLock<RwLock<Option<AcpState>>> =
    std::sync::LazyLock::new(|| RwLock::new(None));

/// Per-session harness launch parameters. Each field, when absent, falls back to
/// the `acp` service entry in the pushed sandbox config — so the manager can
/// pick a harness per session (multi-agent) without a config rebuild.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CreateSessionBody {
    command: Option<String>,
    workdir: Option<String>,
    user: Option<String>,
    env: Option<HashMap<String, String>>,
}

struct ResolvedLaunch {
    command: String,
    user: String,
    workdir: Option<String>,
    env: Option<HashMap<String, String>>,
}

fn resolve_launch(body: CreateSessionBody) -> Result<ResolvedLaunch, String> {
    let svc: Option<ServiceConfig> = get_config().and_then(|c| c.services.get("acp").cloned());

    let command = body
        .command
        .or_else(|| svc.as_ref().and_then(|s| s.command.clone()))
        .ok_or("No ACP harness command configured")?;
    let user = body
        .user
        .or_else(|| svc.as_ref().and_then(|s| s.user.clone()))
        .unwrap_or_else(|| "dev".to_string());
    let workdir = body
        .workdir
        .or_else(|| svc.as_ref().and_then(|s| s.workdir.clone()));
    let env = body.env.or_else(|| svc.and_then(|s| s.env));

    Ok(ResolvedLaunch {
        command,
        user,
        workdir,
        env,
    })
}

async fn create_session(body: CreateSessionBody) -> Result<AcpSessionInfo, String> {
    let launch = resolve_launch(body)?;

    let session_id = generate_session_id("acp");

    let mut cmd = Command::new("/bin/bash");
    cmd.args(["-l", "-c", &launch.command])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // pgid = child pid, so DELETE can SIGTERM the whole harness tree.
        .process_group(0);

    if launch.user == "dev" {
        cmd.uid(1000).gid(1000);
        cmd.env("HOME", "/home/dev");
        cmd.env("USER", "dev");
    }
    if let Some(env) = &launch.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    if let Some(dir) = &launch.workdir {
        cmd.current_dir(dir);
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to spawn harness: {e}"))?;
    let pid = child.id().unwrap_or(0);
    let stdin = child.stdin.take().ok_or("Failed to capture harness stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to capture harness stdout")?;
    let stderr = child.stderr.take();

    let info = AcpSessionInfo {
        id: session_id.clone(),
        pid,
        created_at: utc_rfc3339(),
    };

    let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>(WRITE_CHANNEL_CAPACITY);
    let (output_broadcast, _) = broadcast::channel::<Bytes>(OUTPUT_BROADCAST_CAPACITY);
    let buffer = Arc::new(Mutex::new(OutputBuffer::default()));

    let session = Arc::new(AcpSession {
        info: info.clone(),
        buffer: buffer.clone(),
        output_broadcast: output_broadcast.clone(),
        write_tx,
    });

    {
        let mut guard = ACP_STATE.write().await;
        let state = guard.as_mut().ok_or("ACP server not initialized")?;
        state.sessions.insert(session_id.clone(), session);
    }

    tokio::spawn(run_writer(stdin, write_rx));
    tokio::spawn(run_reader(stdout, buffer, output_broadcast, session_id.clone()));
    if let Some(stderr) = stderr {
        tokio::spawn(pump_stderr_to_log(
            stderr,
            format!("{LOG_DIR}/acp-{session_id}.log"),
        ));
    }
    tokio::spawn(reap_child(child, session_id.clone()));

    println!("acp: created session {session_id} (pid {pid})");
    Ok(info)
}

/// Drains the write channel into the harness stdin.
async fn run_writer(mut stdin: ChildStdin, mut write_rx: mpsc::Receiver<Vec<u8>>) {
    while let Some(data) = write_rx.recv().await {
        if stdin.write_all(&data).await.is_err() || stdin.flush().await.is_err() {
            break;
        }
    }
}

/// Pumps harness stdout into the replay buffer and the live broadcast.
async fn run_reader(
    mut stdout: ChildStdout,
    buffer: Arc<Mutex<OutputBuffer>>,
    output_broadcast: broadcast::Sender<Bytes>,
    session_id: String,
) {
    let mut read_buf = [0u8; READ_BUFFER_SIZE];
    loop {
        match stdout.read(&mut read_buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let bytes = Bytes::copy_from_slice(&read_buf[..n]);
                buffer.lock().await.push(bytes.clone());
                // Errors mean no live subscribers; output is still buffered.
                let _ = output_broadcast.send(bytes);
            }
        }
    }
    println!("acp: stdout closed for session {session_id}");
}

/// Persists harness stderr to a per-session log file for debugging. Kept off the
/// JSON-RPC stream so it never corrupts the protocol.
async fn pump_stderr_to_log(mut stderr: ChildStderr, path: String) {
    let Ok(mut file) = tokio::fs::File::create(&path).await else {
        return;
    };
    let mut buf = [0u8; 8192];
    loop {
        match stderr.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let _ = file.write_all(&buf[..n]).await;
            }
        }
    }
}

/// Awaits harness exit, drops the session from the registry (avoids zombies),
/// and removes the per-session stderr log.
async fn reap_child(mut child: Child, session_id: String) {
    let _ = child.wait().await;
    if let Some(state) = ACP_STATE.write().await.as_mut() {
        state.sessions.remove(&session_id);
    }
    let _ = tokio::fs::remove_file(format!("{LOG_DIR}/acp-{session_id}.log")).await;
    println!("acp: session {session_id} exited");
}

pub async fn list_sessions() -> Vec<AcpSessionInfo> {
    let guard = ACP_STATE.read().await;
    let Some(state) = guard.as_ref() else {
        return vec![];
    };
    state
        .sessions
        .values()
        .map(|session| session.info.clone())
        .collect()
}

pub async fn get_session(session_id: &str) -> Option<AcpSessionInfo> {
    let guard = ACP_STATE.read().await;
    Some(guard.as_ref()?.sessions.get(session_id)?.info.clone())
}

pub async fn delete_session(session_id: &str) -> Result<(), String> {
    let session = {
        let mut guard = ACP_STATE.write().await;
        let state = guard.as_mut().ok_or("ACP server not initialized")?;
        state.sessions.remove(session_id).ok_or("Session not found")?
    };

    // SIGTERM the process group; reap_child still waits on the child (already
    // removed from the map) to avoid a zombie.
    signal_group(session.info.pid, libc::SIGTERM);

    println!("acp: deleted session {session_id}");
    Ok(())
}

// ---- HTTP handlers (on the agent :9998 control plane) --------------------

pub async fn handle_create_session(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let body = match read_body_limited(req, MAX_REQUEST_BODY_BYTES).await {
        Ok(b) => b,
        Err(ReadBodyError::TooLarge) => {
            return json_error(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large")
        }
        Err(ReadBodyError::ReadFailed) => {
            return json_error(StatusCode::BAD_REQUEST, "Failed to read body")
        }
    };

    // An empty body is valid: fall back entirely to the `acp` service config.
    let parsed: CreateSessionBody = if body.is_empty() {
        CreateSessionBody::default()
    } else {
        match serde_json::from_slice(&body) {
            Ok(p) => p,
            Err(_) => return json_error(StatusCode::BAD_REQUEST, "Invalid JSON"),
        }
    };

    match create_session(parsed).await {
        Ok(info) => json_ok(serde_json::to_value(info).unwrap()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

pub async fn handle_list_sessions() -> Response<Full<Bytes>> {
    json_ok(serde_json::to_value(list_sessions().await).unwrap())
}

pub async fn handle_get_session(session_id: &str) -> Response<Full<Bytes>> {
    match get_session(session_id).await {
        Some(info) => json_ok(serde_json::to_value(info).unwrap()),
        None => json_error(StatusCode::NOT_FOUND, "Session not found"),
    }
}

pub async fn handle_delete_session(session_id: &str) -> Response<Full<Bytes>> {
    match delete_session(session_id).await {
        Ok(()) => json_ok(serde_json::json!({"success": true})),
        Err(e) => json_error(StatusCode::NOT_FOUND, &e),
    }
}

// ---- WebSocket bridge (separate TCP listener) ----------------------------

struct WsHandles {
    buffer_chunks: Vec<Bytes>,
    output_rx: broadcast::Receiver<Bytes>,
    write_tx: mpsc::Sender<Vec<u8>>,
}

/// Snapshots everything a WS connection needs in one lock acquisition, so the
/// per-message inbound path never touches the global state lock.
async fn get_session_for_ws(session_id: &str) -> Option<WsHandles> {
    let guard = ACP_STATE.read().await;
    let session = guard.as_ref()?.sessions.get(session_id)?;
    Some(WsHandles {
        buffer_chunks: session.buffer.lock().await.snapshot_chunks(),
        output_rx: session.output_broadcast.subscribe(),
        write_tx: session.write_tx.clone(),
    })
}

async fn handle_ws_connection(stream: tokio::net::TcpStream, session_id: String) {
    let Ok(ws_stream) = accept_async(stream).await else {
        return;
    };
    let Some(WsHandles {
        buffer_chunks,
        mut output_rx,
        write_tx,
    }) = get_session_for_ws(&session_id).await
    else {
        return;
    };

    let (mut ws_sink, mut ws_source) = ws_stream.split();

    // Replay buffered output so a (re)connecting client catches up.
    for chunk in buffer_chunks {
        if ws_sink.send(Message::Binary(chunk)).await.is_err() {
            return;
        }
    }

    println!("acp: client connected to session {session_id}");

    let mut broadcast_forwarder = tokio::spawn(async move {
        loop {
            match output_rx.recv().await {
                Ok(data) => {
                    if ws_sink.send(Message::Binary(data)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    // The client fell behind, so the JSON-RPC byte stream is now
                    // gapped. Disconnect and let the manager reconnect + replay
                    // rather than forwarding a corrupted stream.
                    eprintln!("acp: ws client lagged {n} messages; disconnecting for replay");
                    break;
                }
            }
        }
        let _ = ws_sink.close().await;
    });

    let mut ws_reader = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_source.next().await {
            let data = match msg {
                Message::Binary(b) => b.to_vec(),
                Message::Text(t) => t.as_bytes().to_vec(),
                Message::Close(_) => break,
                _ => continue,
            };
            if write_tx.send(data).await.is_err() {
                break;
            }
        }
    });

    // select! only drops the losing JoinHandle (which detaches, not aborts), so
    // explicitly abort the sibling to avoid leaking a task holding the socket.
    tokio::select! {
        _ = &mut broadcast_forwarder => ws_reader.abort(),
        _ = &mut ws_reader => broadcast_forwarder.abort(),
    }

    println!("acp: client disconnected from session {session_id}");
}

pub async fn start_acp_server(port: u16) {
    let Ok(listener) = TcpListener::bind(("0.0.0.0", port)).await else {
        eprintln!("acp: failed to bind port {port}");
        return;
    };
    println!("ACP WebSocket server listening on port {port}");

    while let Ok((stream, addr)) = listener.accept().await {
        let mut buf = [0u8; 1024];
        let Ok(n) = stream.peek(&mut buf).await else {
            continue;
        };
        if let Some(id) = parse_session_id_from_request(&buf[..n]) {
            println!("acp: connection from {addr} for session {id}");
            tokio::spawn(handle_ws_connection(stream, id));
        }
    }
}

pub async fn ensure_acp_running(port: u16) {
    {
        let mut guard = ACP_STATE.write().await;
        if let Some(state) = guard.as_ref() {
            if state.port != port {
                eprintln!(
                    "acp: server already running on port {}, ignoring port {}",
                    state.port, port
                );
            }
            return;
        }
        *guard = Some(AcpState {
            port,
            sessions: HashMap::new(),
        });
    }

    tokio::spawn(async move {
        start_acp_server(port).await;
    });
}

pub async fn ensure_acp_from_config() {
    let Some(config) = get_config() else { return };
    let Some(service) = config.services.get("acp") else {
        return;
    };
    if service.enabled == Some(false) {
        return;
    }
    let Some(port) = service.port else {
        eprintln!("acp: service configured without a port; bridge not started");
        return;
    };
    ensure_acp_running(port).await;
}
