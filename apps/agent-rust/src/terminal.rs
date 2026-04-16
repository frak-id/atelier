use std::collections::HashMap;
use std::collections::VecDeque;
use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, RawFd};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Request, Response, StatusCode};
use nix::sys::signal::{kill, Signal};
use nix::unistd::{execvp, fork, setgid, setsid, setuid, ForkResult, Gid, Pid, Uid};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, mpsc, watch, Mutex, RwLock};
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

use nix::sys::wait::{waitpid, WaitPidFlag, WaitStatus};
use tokio::io::unix::AsyncFd;

use crate::body::{read_body_limited, ReadBodyError};
use crate::config::get_config;
use crate::limits::MAX_REQUEST_BODY_BYTES;
use crate::response::{json_error, json_ok};
use crate::utc_rfc3339;

const BUFFER_LIMIT: usize = 1024 * 1024 * 2;
const SESSION_SWEEP_INTERVAL: Duration = Duration::from_secs(30);
const SESSION_IDLE_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Default)]
struct OutputBuffer {
    chunks: VecDeque<Bytes>,
    total_len: usize,
}

impl OutputBuffer {
    fn push(&mut self, chunk: Bytes) {
        if chunk.is_empty() {
            return;
        }
        self.total_len = self.total_len.saturating_add(chunk.len());
        self.chunks.push_back(chunk);
        self.trim_to_limit();
    }

    fn snapshot_chunks(&self) -> Vec<Bytes> {
        self.chunks.iter().cloned().collect()
    }

    fn trim_to_limit(&mut self) {
        while self.total_len > BUFFER_LIMIT {
            let excess = self.total_len - BUFFER_LIMIT;
            let Some(front) = self.chunks.pop_front() else {
                self.total_len = 0;
                break;
            };
            if front.len() <= excess {
                self.total_len -= front.len();
                continue;
            }

            // Keep only the tail of the front chunk, slicing without copying.
            let keep = front.slice(excess..);
            self.total_len -= excess;
            self.chunks.push_front(keep);
            break;
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub user_id: String,
    pub title: String,
    pub created_at: String,
}

struct ActiveSession {
    master_fd: RawFd,
    buffer: Arc<Mutex<OutputBuffer>>,
    output_broadcast: broadcast::Sender<Bytes>,
    meta: Mutex<SessionMetadata>,
}

struct SessionMetadata {
    info: SessionInfo,
    child_pid: Pid,
    write_tx: mpsc::Sender<Vec<u8>>,
    shutdown_tx: watch::Sender<bool>,
    last_activity: Instant,
}

struct PtyMasterFd {
    fd: RawFd,
}

impl AsRawFd for PtyMasterFd {
    fn as_raw_fd(&self) -> RawFd {
        self.fd
    }
}

struct TerminalState {
    port: u16,
    sessions: HashMap<String, Arc<ActiveSession>>,
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

fn pty_read(fd: RawFd, buf: &mut [u8]) -> io::Result<usize> {
    loop {
        let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
        if n >= 0 {
            return Ok(n as usize);
        }

        let err = io::Error::last_os_error();
        if err.kind() == io::ErrorKind::Interrupted {
            continue;
        }
        return Err(err);
    }
}

fn pty_write(fd: RawFd, data: &[u8]) -> io::Result<usize> {
    loop {
        let n = unsafe { libc::write(fd, data.as_ptr() as *const libc::c_void, data.len()) };
        if n >= 0 {
            return Ok(n as usize);
        }

        let err = io::Error::last_os_error();
        if err.kind() == io::ErrorKind::Interrupted {
            continue;
        }
        return Err(err);
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
    if unsafe { libc::ioctl(fd, libc::TIOCSWINSZ, &ws) } == -1 {
        return;
    }
    let fg_pgrp = unsafe { libc::tcgetpgrp(fd) };
    if fg_pgrp > 0 {
        unsafe { libc::kill(-fg_pgrp, libc::SIGWINCH) };
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
    let flags = unsafe { libc::fcntl(master_fd, libc::F_GETFL) };
    if flags == -1 {
        unsafe {
            libc::close(master_fd);
            libc::close(slave_fd);
        }
        return Err("Failed to get PTY fd flags".to_string());
    }
    if unsafe { libc::fcntl(master_fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        unsafe {
            libc::close(master_fd);
            libc::close(slave_fd);
        }
        return Err("Failed to set PTY fd non-blocking".to_string());
    }
    set_winsize(master_fd, 80, 24);

    let workdir_path = workdir.unwrap_or_else(|| "/home/dev".to_string());
    let child_pid = match unsafe { fork() } {
        Ok(ForkResult::Child) => {
            unsafe { libc::close(master_fd) };
            let _ = setsid();
            unsafe { libc::dup2(slave_fd, 0) };
            unsafe { libc::dup2(slave_fd, 1) };
            unsafe { libc::dup2(slave_fd, 2) };
            if slave_fd > 2 {
                unsafe { libc::close(slave_fd) };
            }
            unsafe {
                libc::ioctl(0, libc::TIOCSCTTY as _, 0);
                libc::signal(libc::SIGCHLD, libc::SIG_DFL);
                libc::signal(libc::SIGHUP, libc::SIG_DFL);
                libc::signal(libc::SIGINT, libc::SIG_DFL);
                libc::signal(libc::SIGQUIT, libc::SIG_DFL);
                libc::signal(libc::SIGTERM, libc::SIG_DFL);
                libc::signal(libc::SIGWINCH, libc::SIG_DFL);
                let empty_set: libc::sigset_t = std::mem::zeroed();
                libc::sigprocmask(libc::SIG_SETMASK, &empty_set, std::ptr::null_mut());
            }
            unsafe {
                std::env::set_var("TERM", "xterm-256color");
                std::env::set_var("HOME", "/home/dev");
                std::env::set_var("USER", "dev");
                std::env::set_var("SHELL", "/bin/bash");
            }
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
        created_at: utc_rfc3339(),
    };

    let (write_tx, mut write_rx) = mpsc::channel::<Vec<u8>>(64);
    let (output_broadcast, _) = broadcast::channel::<Bytes>(256);
    let buffer = Arc::new(Mutex::new(OutputBuffer::default()));
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let master_async_fd = Arc::new(
        AsyncFd::new(PtyMasterFd { fd: master_fd })
            .map_err(|e| format!("Failed to register PTY fd: {e}"))?,
    );

    let session = Arc::new(ActiveSession {
        master_fd,
        buffer: buffer.clone(),
        output_broadcast: output_broadcast.clone(),
        meta: Mutex::new(SessionMetadata {
            info: info.clone(),
            child_pid,
            write_tx,
            shutdown_tx,
            last_activity: Instant::now(),
        }),
    });

    state.sessions.insert(session_id.clone(), session.clone());

    let writer_fd = master_async_fd.clone();
    let mut writer_shutdown_rx = shutdown_rx.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = writer_shutdown_rx.changed() => {
                    if *writer_shutdown_rx.borrow() {
                        break;
                    }
                }
                maybe = write_rx.recv() => {
                    let Some(data) = maybe else { break; };
                    let mut written = 0;
                    while written < data.len() {
                        let mut guard = match writer_fd.writable().await {
                            Ok(guard) => guard,
                            Err(_) => return,
                        };
                        let result = guard.try_io(|inner| {
                            pty_write(inner.get_ref().as_raw_fd(), &data[written..])
                        });

                        match result {
                            Ok(Ok(0)) => return,
                            Ok(Ok(n)) => {
                                written += n;
                            }
                            Ok(Err(_)) => return,
                            Err(_would_block) => continue,
                        }
                    }
                }
            }
        }
    });

    let reader_master_fd = master_async_fd.clone();
    let reader_buffer = buffer;
    let reader_output_broadcast = output_broadcast;
    let reader_session = session.clone();
    let reader_session_id = session_id.clone();
    let mut reader_shutdown_rx = shutdown_rx;
    tokio::spawn(async move {
        const READ_BUFFER_SIZE: usize = 16 * 1024;
        const COALESCE_MAX_WAIT: Duration = Duration::from_millis(2);
        let mut read_buf = [0u8; READ_BUFFER_SIZE];

        loop {
            tokio::select! {
                _ = reader_shutdown_rx.changed() => {
                    if *reader_shutdown_rx.borrow() {
                        break;
                    }
                }
                readable = reader_master_fd.readable() => {
                    let mut guard = match readable {
                        Ok(guard) => guard,
                        Err(_) => {
                            let _ = delete_session(&reader_session_id).await;
                            break;
                        }
                    };

                    let mut combined = Vec::with_capacity(READ_BUFFER_SIZE);
                    let coalesce_deadline = Instant::now() + COALESCE_MAX_WAIT;
                    let mut should_delete = false;

                    loop {
                        let read_result = guard.try_io(|inner| {
                            pty_read(inner.get_ref().as_raw_fd(), &mut read_buf)
                        });

                        match read_result {
                            Ok(Ok(0)) => {
                                should_delete = true;
                                break;
                            }
                            Ok(Ok(n)) => {
                                combined.extend_from_slice(&read_buf[..n]);
                                if combined.len() >= READ_BUFFER_SIZE {
                                    break;
                                }
                            }
                            Ok(Err(_)) => {
                                should_delete = true;
                                break;
                            }
                            Err(_would_block) => {
                                break;
                            }
                        }

                        let now = Instant::now();
                        if now >= coalesce_deadline {
                            break;
                        }

                        match tokio::time::timeout(
                            coalesce_deadline.saturating_duration_since(now),
                            reader_master_fd.readable(),
                        )
                        .await
                        {
                            Ok(Ok(next_guard)) => {
                                guard = next_guard;
                            }
                            Ok(Err(_)) => {
                                should_delete = true;
                                break;
                            }
                            Err(_) => {
                                break;
                            }
                        }
                    }

                    if !combined.is_empty() {
                        let bytes = Bytes::from(combined);
                        {
                            let mut buffer = reader_buffer.lock().await;
                            buffer.push(bytes.clone());
                        }
                        let _ = reader_output_broadcast.send(bytes);
                        reader_session.meta.lock().await.last_activity = Instant::now();
                    }

                    if should_delete {
                        let _ = delete_session(&reader_session_id).await;
                        break;
                    }
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
    let Some(state) = guard.as_ref() else {
        return vec![];
    };
    let mut sessions = Vec::with_capacity(state.sessions.len());
    for session in state.sessions.values() {
        sessions.push(session.meta.lock().await.info.clone());
    }
    sessions
}

pub async fn get_session(session_id: &str) -> Option<SessionInfo> {
    let guard = TERMINAL_STATE.read().await;
    let state = guard.as_ref()?;
    let session = state.sessions.get(session_id)?;
    let s = session.meta.lock().await;
    Some(s.info.clone())
}

pub async fn delete_session(session_id: &str) -> Result<(), String> {
    let mut guard = TERMINAL_STATE.write().await;
    let state = guard.as_mut().ok_or("Terminal server not initialized")?;

    let session = state
        .sessions
        .remove(session_id)
        .ok_or("Session not found")?;

    let (master_fd, child_pid, shutdown_tx) = {
        let s = session.meta.lock().await;
        (session.master_fd, s.child_pid, s.shutdown_tx.clone())
    };

    let _ = shutdown_tx.send(true);

    let _ = kill(Pid::from_raw(-child_pid.as_raw()), Signal::SIGHUP);
    unsafe {
        libc::close(master_fd);
    }

    // Reap the forked PTY child to avoid accumulating zombies.
    tokio::task::spawn_blocking(move || {
        let mut waited = false;
        for _ in 0..20 {
            match waitpid(child_pid, Some(WaitPidFlag::WNOHANG)) {
                Ok(WaitStatus::StillAlive) => {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                Ok(_) => {
                    waited = true;
                    break;
                }
                Err(_) => break,
            }
        }

        if !waited {
            let _ = kill(Pid::from_raw(-child_pid.as_raw()), Signal::SIGKILL);
            let _ = waitpid(child_pid, None);
        }
    });

    println!("terminal: deleted session {}", session_id);
    Ok(())
}

pub async fn resize_session(session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let guard = TERMINAL_STATE.read().await;
    let state = guard.as_ref().ok_or("Terminal server not initialized")?;
    let session = state.sessions.get(session_id).ok_or("Session not found")?;

    {
        let mut s = session.meta.lock().await;
        s.last_activity = Instant::now();
        set_winsize(session.master_fd, cols, rows);
    }
    Ok(())
}

pub async fn write_to_session(session_id: &str, data: Vec<u8>) -> Result<(), String> {
    let guard = TERMINAL_STATE.read().await;
    let state = guard.as_ref().ok_or("Terminal server not initialized")?;
    let session = state.sessions.get(session_id).ok_or("Session not found")?;

    let write_tx = {
        let mut s = session.meta.lock().await;
        s.last_activity = Instant::now();
        s.write_tx.clone()
    };

    write_tx
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

#[derive(Deserialize)]
struct WsCommand {
    r#type: String,
    cols: Option<u16>,
    rows: Option<u16>,
}

fn try_parse_resize(data: &[u8]) -> Option<(u16, u16)> {
    let cmd: WsCommand = serde_json::from_slice(data).ok()?;
    if cmd.r#type != "resize" {
        return None;
    }
    Some((cmd.cols.unwrap_or(80), cmd.rows.unwrap_or(24)))
}

pub async fn handle_create_session(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let body = match read_body_limited(req, MAX_REQUEST_BODY_BYTES).await {
        Ok(b) => b,
        Err(ReadBodyError::TooLarge) => {
            return json_ok(serde_json::json!({
                "error": "Request body too large"
            }))
        }
        Err(ReadBodyError::ReadFailed) => {
            return json_error(StatusCode::BAD_REQUEST, "Failed to read body")
        }
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

async fn get_session_for_ws(
    session_id: &str,
) -> Option<(Vec<Bytes>, broadcast::Receiver<Bytes>)> {
    let guard = TERMINAL_STATE.read().await;
    let state = guard.as_ref()?;
    let session = state.sessions.get(session_id)?;
    let chunks = session.buffer.lock().await.snapshot_chunks();
    Some((chunks, session.output_broadcast.subscribe()))
}

async fn handle_ws_connection(stream: tokio::net::TcpStream, session_id: String) {
    let Ok(ws_stream) = accept_async(stream).await else {
        return;
    };

    let Some((buffer_chunks, mut output_rx)) = get_session_for_ws(&session_id).await else {
        return;
    };

    let (mut ws_sink, mut ws_source) = ws_stream.split();

    for chunk in buffer_chunks {
        if ws_sink
            .send(Message::Binary(chunk))
            .await
            .is_err()
        {
            return;
        }
    }

    println!("terminal: client connected to session {}", session_id);

    let broadcast_forwarder = tokio::spawn(async move {
        while let Ok(data) = output_rx.recv().await {
            if ws_sink
                .send(Message::Binary(data))
                .await
                .is_err()
            {
                break;
            }
        }
        let _ = ws_sink.close().await;
    });

    let ws_reader_session_id = session_id.clone();
    let ws_reader = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_source.next().await {
            let data = match msg {
                Message::Binary(b) => b.to_vec(),
                Message::Text(t) => t.as_bytes().to_vec(),
                Message::Close(_) => break,
                _ => continue,
            };

            if let Some((cols, rows)) = try_parse_resize(&data) {
                let _ = resize_session(&ws_reader_session_id, cols, rows).await;
            } else {
                let _ = write_to_session(&ws_reader_session_id, data).await;
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

    tokio::spawn(async {
        loop {
            tokio::time::sleep(SESSION_SWEEP_INTERVAL).await;
            sweep_sessions().await;
        }
    });
}

async fn sweep_sessions() {
    let sessions: Vec<(String, Arc<ActiveSession>)> = {
        let guard = TERMINAL_STATE.read().await;
        let Some(state) = guard.as_ref() else {
            return;
        };
        state
            .sessions
            .iter()
            .map(|(id, s)| (id.clone(), s.clone()))
            .collect()
    };

    let now = Instant::now();
    let mut stale_ids = Vec::new();
    for (id, session) in sessions {
        let s = session.meta.lock().await;
        let idle = now.duration_since(s.last_activity) > SESSION_IDLE_TTL;
        let alive = unsafe { libc::kill(s.child_pid.as_raw(), 0) == 0 };
        if idle || !alive {
            stale_ids.push(id);
        }
    }

    for id in stale_ids {
        let _ = delete_session(&id).await;
    }
}

pub async fn ensure_terminal_from_config() {
    let Some(config) = get_config() else { return };
    let Some(service) = config.services.get("terminal") else {
        return;
    };
    if service.enabled == Some(false) {
        return;
    }
    ensure_terminal_running(service.port.unwrap_or(7681)).await;
}

fn parse_session_id_from_request(buf: &[u8]) -> Option<String> {
    let request = String::from_utf8_lossy(buf);
    let path = request.lines().next()?.split_whitespace().nth(1)?;
    let id = path.strip_prefix('/')?;
    (!id.is_empty() && !id.contains(' ')).then(|| id.to_string())
}

pub async fn start_terminal_server(port: u16) {
    ensure_devpts().await;

    let Ok(listener) = TcpListener::bind(("0.0.0.0", port)).await else {
        eprintln!("terminal: failed to bind port {port}");
        return;
    };
    println!("Terminal WebSocket server listening on port {port}");

    while let Ok((stream, addr)) = listener.accept().await {
        let mut buf = [0u8; 1024];
        let Ok(n) = stream.peek(&mut buf).await else {
            continue;
        };

        if let Some(id) = parse_session_id_from_request(&buf[..n]) {
            println!("terminal: connection from {addr} for session {id}");
            tokio::spawn(handle_ws_connection(stream, id));
        }
    }
}
