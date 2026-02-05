use std::collections::HashMap;
use std::ffi::CString;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::{Request, Response, StatusCode};
use nix::sys::signal::{kill, Signal};
use nix::unistd::{close, dup2, execvp, fork, setgid, setsid, setuid, ForkResult, Gid, Pid, Uid};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc, Mutex, RwLock};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

use crate::config::get_config;
use crate::response::{json_error, json_ok};
use crate::utc_rfc3339;

const BUFFER_LIMIT: usize = 1024 * 1024 * 2;
const BUFFER_CHUNK: usize = 64 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub user_id: String,
    pub title: String,
    pub status: SessionStatus,
    pub created_at: String,
}

#[derive(Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Running,
    Exited,
}

struct ActiveSession {
    info: SessionInfo,
    master_fd: i32,
    child_pid: Pid,
    buffer: String,
    write_tx: mpsc::Sender<Vec<u8>>,
    output_broadcast: broadcast::Sender<Vec<u8>>,
}

struct TerminalState {
    port: u16,
    sessions: HashMap<String, Arc<Mutex<ActiveSession>>>,
}

static TERMINAL_STATE: std::sync::LazyLock<RwLock<Option<TerminalState>>> =
    std::sync::LazyLock::new(|| RwLock::new(None));

fn raw_openpty() -> Option<(i32, i32)> {
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let ret = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ret == 0 {
        Some((master, slave))
    } else {
        None
    }
}

async fn ensure_devpts() {
    let _ = tokio::process::Command::new("mount")
        .args(["-t", "devpts", "devpts", "/dev/pts"])
        .status()
        .await;
}

fn set_winsize(fd: i32, cols: u16, rows: u16) {
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe {
        libc::ioctl(fd, libc::TIOCSWINSZ, &ws);
    }
}

fn generate_session_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("pty_{:x}", nanos)
}

pub async fn create_session(
    user_id: String,
    title: Option<String>,
    command: Option<String>,
    workdir: Option<String>,
) -> Result<SessionInfo, String> {
    let mut guard = TERMINAL_STATE.write().await;
    let state = guard.as_mut().ok_or("Terminal server not initialized")?;

    let (master_fd, slave_fd) = raw_openpty().ok_or("Failed to open PTY")?;
    set_winsize(master_fd, 80, 24);

    let workdir_path = workdir.unwrap_or_else(|| "/home/dev".to_string());
    let child_pid = match unsafe { fork() } {
        Ok(ForkResult::Child) => {
            unsafe { libc::close(master_fd) };
            let _ = setsid();
            unsafe {
                libc::ioctl(slave_fd, libc::TIOCSCTTY as _, 0);
            }
            let _ = dup2(slave_fd, 0);
            let _ = dup2(slave_fd, 1);
            let _ = dup2(slave_fd, 2);
            if slave_fd > 2 {
                let _ = close(slave_fd);
            }
            std::env::set_var("TERM", "xterm-256color");
            std::env::set_var("HOME", "/home/dev");
            std::env::set_var("USER", "dev");
            std::env::set_var("SHELL", "/bin/bash");
            let _ = setgid(Gid::from_raw(1000));
            let _ = setuid(Uid::from_raw(1000));
            let _ = std::env::set_current_dir(&workdir_path);
            let cmd = CString::new("/bin/bash").unwrap();
            let args: Vec<CString> = match &command {
                Some(c) => vec![
                    CString::new("/bin/bash").unwrap(),
                    CString::new("-l").unwrap(),
                    CString::new("-c").unwrap(),
                    CString::new(c.as_str()).unwrap(),
                ],
                None => vec![
                    CString::new("/bin/bash").unwrap(),
                    CString::new("-l").unwrap(),
                ],
            };
            let _ = execvp(&cmd, &args);
            std::process::exit(1);
        }
        Ok(ForkResult::Parent { child }) => {
            unsafe { libc::close(slave_fd) };
            child
        }
        Err(e) => {
            unsafe {
                libc::close(master_fd);
                libc::close(slave_fd);
            }
            return Err(format!("Fork failed: {e}"));
        }
    };

    let session_id = generate_session_id();
    let info = SessionInfo {
        id: session_id.clone(),
        user_id: user_id.clone(),
        title: title.unwrap_or_else(|| format!("Terminal {}", &session_id[4..12])),
        status: SessionStatus::Running,
        created_at: utc_rfc3339(),
    };

    let (write_tx, mut write_rx) = mpsc::channel::<Vec<u8>>(64);
    let (output_broadcast, _) = broadcast::channel::<Vec<u8>>(256);

    let session = Arc::new(Mutex::new(ActiveSession {
        info: info.clone(),
        master_fd,
        child_pid,
        buffer: String::new(),
        write_tx,
        output_broadcast: output_broadcast.clone(),
    }));

    state.sessions.insert(session_id.clone(), session.clone());

    let writer_session = session.clone();
    tokio::spawn(async move {
        while let Some(data) = write_rx.recv().await {
            let fd = {
                let s = writer_session.lock().await;
                if s.info.status != SessionStatus::Running {
                    break;
                }
                s.master_fd
            };
            let _ = tokio::task::spawn_blocking(move || unsafe {
                libc::write(fd, data.as_ptr() as *const libc::c_void, data.len());
            })
            .await;
        }
    });

    let reader_session = session.clone();
    let reader_session_id = session_id.clone();
    tokio::spawn(async move {
        loop {
            let fd = {
                let s = reader_session.lock().await;
                if s.info.status != SessionStatus::Running {
                    break;
                }
                s.master_fd
            };

            let result = tokio::task::spawn_blocking(move || {
                let mut buf = [0u8; 4096];
                let n =
                    unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
                if n > 0 {
                    Some(buf[..n as usize].to_vec())
                } else {
                    None
                }
            })
            .await;

            match result {
                Ok(Some(data)) => {
                    let mut s = reader_session.lock().await;
                    if let Ok(text) = String::from_utf8(data.clone()) {
                        s.buffer.push_str(&text);
                        if s.buffer.len() > BUFFER_LIMIT {
                            let excess = s.buffer.len() - BUFFER_LIMIT;
                            s.buffer = s.buffer[excess..].to_string();
                        }
                    }
                    let _ = s.output_broadcast.send(data);
                }
                _ => {
                    let mut s = reader_session.lock().await;
                    s.info.status = SessionStatus::Exited;
                    println!("terminal: session {} exited", reader_session_id);
                    break;
                }
            }
        }
    });

    println!(
        "terminal: created session {} for user {}",
        session_id, user_id
    );
    Ok(info)
}

pub async fn list_sessions() -> Vec<SessionInfo> {
    let guard = TERMINAL_STATE.read().await;
    match guard.as_ref() {
        Some(state) => {
            let mut sessions = Vec::new();
            for session in state.sessions.values() {
                let s = session.lock().await;
                sessions.push(s.info.clone());
            }
            sessions
        }
        None => Vec::new(),
    }
}

pub async fn get_session(session_id: &str) -> Option<SessionInfo> {
    let guard = TERMINAL_STATE.read().await;
    let state = guard.as_ref()?;
    let session = state.sessions.get(session_id)?;
    let s = session.lock().await;
    Some(s.info.clone())
}

pub async fn delete_session(session_id: &str) -> Result<(), String> {
    let mut guard = TERMINAL_STATE.write().await;
    let state = guard.as_mut().ok_or("Terminal server not initialized")?;

    let session = state
        .sessions
        .remove(session_id)
        .ok_or("Session not found")?;

    let s = session.lock().await;
    let _ = kill(Pid::from_raw(-s.child_pid.as_raw()), Signal::SIGHUP);
    unsafe {
        libc::close(s.master_fd);
    }

    println!("terminal: deleted session {}", session_id);
    Ok(())
}

pub async fn resize_session(session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let guard = TERMINAL_STATE.read().await;
    let state = guard.as_ref().ok_or("Terminal server not initialized")?;
    let session = state.sessions.get(session_id).ok_or("Session not found")?;

    let s = session.lock().await;
    if s.info.status == SessionStatus::Running {
        set_winsize(s.master_fd, cols, rows);
    }
    Ok(())
}

pub async fn write_to_session(session_id: &str, data: Vec<u8>) -> Result<(), String> {
    let guard = TERMINAL_STATE.read().await;
    let state = guard.as_ref().ok_or("Terminal server not initialized")?;
    let session = state.sessions.get(session_id).ok_or("Session not found")?;

    let s = session.lock().await;
    if s.info.status != SessionStatus::Running {
        return Err("Session not running".to_string());
    }
    s.write_tx
        .send(data)
        .await
        .map_err(|_| "Write channel closed".to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionBody {
    user_id: String,
    title: Option<String>,
    command: Option<String>,
    workdir: Option<String>,
}

async fn read_body(req: Request<hyper::body::Incoming>) -> Result<Bytes, hyper::Error> {
    Ok(req.collect().await?.to_bytes())
}

pub async fn handle_create_session(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "Failed to read body"),
    };

    let parsed: CreateSessionBody = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(_) => return json_error(StatusCode::BAD_REQUEST, "Invalid JSON"),
    };

    match create_session(parsed.user_id, parsed.title, parsed.command, parsed.workdir).await {
        Ok(info) => json_ok(serde_json::to_value(info).unwrap()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

pub async fn handle_list_sessions() -> Response<Full<Bytes>> {
    let sessions = list_sessions().await;
    json_ok(serde_json::to_value(sessions).unwrap())
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

async fn handle_ws_connection(stream: tokio::net::TcpStream, session_id: String) {
    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("terminal: ws handshake failed: {e}");
            return;
        }
    };

    let (buffer, status, mut output_rx) = {
        let guard = TERMINAL_STATE.read().await;
        let state = match guard.as_ref() {
            Some(s) => s,
            None => {
                eprintln!("terminal: state not initialized");
                return;
            }
        };
        let session = match state.sessions.get(&session_id) {
            Some(s) => s,
            None => {
                eprintln!("terminal: session {} not found", session_id);
                return;
            }
        };
        let s = session.lock().await;
        (s.buffer.clone(), s.info.status, s.output_broadcast.subscribe())
    };

    if status == SessionStatus::Exited {
        eprintln!("terminal: session {} already exited", session_id);
        return;
    }

    let (mut ws_sink, mut ws_source) = ws_stream.split();

    if !buffer.is_empty() {
        let buffer_bytes = buffer.as_bytes();
        for chunk_start in (0..buffer_bytes.len()).step_by(BUFFER_CHUNK) {
            let chunk_end = (chunk_start + BUFFER_CHUNK).min(buffer_bytes.len());
            let chunk = &buffer_bytes[chunk_start..chunk_end];
            if ws_sink.send(Message::Binary(chunk.to_vec().into())).await.is_err() {
                return;
            }
        }
    }

    println!("terminal: client connected to session {}", session_id);

    let broadcast_forwarder = tokio::spawn(async move {
        while let Ok(data) = output_rx.recv().await {
            if ws_sink.send(Message::Binary(data.into())).await.is_err() {
                break;
            }
        }
        let _ = ws_sink.close().await;
    });

    let ws_reader_session_id = session_id.clone();
    let ws_reader = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_source.next().await {
            match msg {
                Message::Binary(data) => {
                    let _ = write_to_session(&ws_reader_session_id, data.into()).await;
                }
                Message::Text(text) => {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                        if val.get("type").and_then(|t| t.as_str()) == Some("resize") {
                            let cols = val.get("cols").and_then(|c| c.as_u64()).unwrap_or(80) as u16;
                            let rows = val.get("rows").and_then(|r| r.as_u64()).unwrap_or(24) as u16;
                            let _ = resize_session(&ws_reader_session_id, cols, rows).await;
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = broadcast_forwarder => {}
        _ = ws_reader => {}
    }

    println!("terminal: client disconnected from session {}", session_id);
}

pub async fn ensure_terminal_running(port: u16) {
    let mut guard = TERMINAL_STATE.write().await;
    if let Some(state) = guard.as_ref() {
        if state.port == port {
            return;
        }
        eprintln!(
            "terminal: server already running on port {}, ignoring port {}",
            state.port, port
        );
        return;
    }

    *guard = Some(TerminalState {
        port,
        sessions: HashMap::new(),
    });
    drop(guard);

    tokio::spawn(async move {
        start_terminal_server(port).await;
    });
}

pub async fn ensure_terminal_from_config() {
    let config = match get_config() {
        Some(cfg) => cfg,
        None => return,
    };

    let service = match config.services.get("terminal") {
        Some(cfg) => cfg,
        None => return,
    };

    if service.enabled == Some(false) {
        return;
    }

    let port = service.port.unwrap_or(7681);
    ensure_terminal_running(port).await;
}

pub async fn start_terminal_server(port: u16) {
    ensure_devpts().await;

    let listener = match TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("terminal: failed to bind port {port}: {e}");
            return;
        }
    };
    println!("Terminal WebSocket server listening on port {port}");

    loop {
        match listener.accept().await {
            Ok((stream, addr)) => {
                let mut buf = [0u8; 1024];
                match stream.peek(&mut buf).await {
                    Ok(n) => {
                        let request = String::from_utf8_lossy(&buf[..n]);
                        let session_id = request
                            .lines()
                            .next()
                            .and_then(|line| line.split_whitespace().nth(1))
                            .and_then(|path| path.strip_prefix('/'))
                            .map(|s| s.to_string());

                        match session_id {
                            Some(id) if !id.is_empty() && !id.contains(' ') => {
                                println!("terminal: connection from {addr} for session {id}");
                                tokio::spawn(handle_ws_connection(stream, id));
                            }
                            _ => {
                                eprintln!("terminal: invalid request from {addr}");
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("terminal: peek error: {e}");
                    }
                };
            }
            Err(e) => {
                eprintln!("terminal: accept error: {e}");
            }
        }
    }
}
