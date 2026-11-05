//! Unified attach bridge — one mechanism for a process's stdio. A process with
//! `stdio: "bridge"` gets its stdin/stdout relayed over a WebSocket; a process
//! with `pty: true` gets a PTY. Both fan output out to any number of read-only
//! (`mode=ro`) clients with ring-buffer replay, and admit at most ONE writer
//! (`mode=rw`) at a time — a single-writer guard, since two concurrent writers
//! would interleave and corrupt the JSON-RPC frame stream. A client that
//! passes `replay=0` skips the ring-buffer replay and sees live output only.

use std::collections::HashMap;
use std::os::fd::{AsRawFd, RawFd};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use futures_util::{SinkExt, StreamExt};
use hyper::body::Bytes;
use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, Notify, broadcast, mpsc};
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::Message;

use crate::auth::Auth;
use crate::bridge::{AttachTarget, OutputBuffer, parse_attach_target};
use crate::limits::{OUTPUT_BROADCAST_CAPACITY, READ_BUFFER_SIZE, WRITE_CHANNEL_CAPACITY};
use crate::logfile::LogFile;
use crate::terminal::TerminalRegistry;

pub const ATTACH_PORT: u16 = 9997;

/// One attachable process endpoint: live output fan-out + replay + a write
/// sink, guarded by a single-writer slot.
pub struct AttachEndpoint {
    output: broadcast::Sender<Bytes>,
    buffer: Arc<Mutex<OutputBuffer>>,
    write_tx: mpsc::Sender<Vec<u8>>,
    slot: WriterSlot,
}

/// The single-writer guard. `holder == 0` means free; a non-zero token names
/// the current `rw` attach. A takeover installs a new token and notifies the
/// evicted holder to stop writing.
struct WriterSlot {
    holder: Mutex<u64>,
    evict: Arc<Notify>,
    counter: AtomicU64,
}

impl WriterSlot {
    fn new() -> Self {
        Self {
            holder: Mutex::new(0),
            evict: Arc::new(Notify::new()),
            counter: AtomicU64::new(0),
        }
    }

    /// A cloneable handle the writer task awaits to learn a takeover evicted it.
    fn evict_handle(&self) -> Arc<Notify> {
        self.evict.clone()
    }

    /// Try to become the writer. Fails (returns `None`) if another writer holds
    /// the slot and `takeover` is false; otherwise installs a fresh token,
    /// evicting any prior holder.
    async fn try_acquire(&self, takeover: bool) -> Option<u64> {
        let mut holder = self.holder.lock().await;
        if *holder != 0 && !takeover {
            return None;
        }
        let had_holder = *holder != 0;
        let token = self.counter.fetch_add(1, Ordering::SeqCst) + 1;
        *holder = token;
        drop(holder);
        if had_holder {
            self.evict.notify_waiters();
        }
        Some(token)
    }

    async fn is_holder(&self, token: u64) -> bool {
        *self.holder.lock().await == token
    }

    /// Release the slot if `token` still holds it (a takeover may have moved on).
    async fn release(&self, token: u64) {
        let mut holder = self.holder.lock().await;
        if *holder == token {
            *holder = 0;
        }
    }
}

impl AttachEndpoint {
    fn new(write_tx: mpsc::Sender<Vec<u8>>) -> Arc<Self> {
        let (output, _) = broadcast::channel(OUTPUT_BROADCAST_CAPACITY);
        Arc::new(Self {
            output,
            buffer: Arc::new(Mutex::new(OutputBuffer::default())),
            write_tx,
            slot: WriterSlot::new(),
        })
    }

    /// Fan a chunk of process output to the replay buffer and live subscribers.
    async fn publish(&self, chunk: Bytes) {
        self.buffer.lock().await.push(chunk.clone());
        let _ = self.output.send(chunk);
    }
}

/// Per-sandbox registry of attach endpoints, keyed by process name.
pub struct AttachRegistry {
    endpoints: Mutex<HashMap<String, Arc<AttachEndpoint>>>,
}

impl AttachRegistry {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            endpoints: Mutex::new(HashMap::new()),
        })
    }

    async fn get(&self, name: &str) -> Option<Arc<AttachEndpoint>> {
        self.endpoints.lock().await.get(name).cloned()
    }

    pub async fn remove(&self, name: &str) {
        self.endpoints.lock().await.remove(name);
    }

    /// Wire a stdio-bridge process: pump its stdout to the endpoint (tee'd to
    /// the log), drain the write channel into its stdin.
    pub async fn register_bridge(
        &self,
        name: &str,
        stdin: ChildStdin,
        stdout: ChildStdout,
        log: Arc<LogFile>,
    ) {
        let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>(WRITE_CHANNEL_CAPACITY);
        let endpoint = AttachEndpoint::new(write_tx);
        self.endpoints
            .lock()
            .await
            .insert(name.to_string(), endpoint.clone());

        tokio::spawn(drain_to_stdin(stdin, write_rx));
        tokio::spawn(pump_stdout(stdout, endpoint, log));
    }

    /// Wire a PTY process: pump the master fd to the endpoint (tee'd to the
    /// log), drain the write channel into the master fd.
    pub async fn register_pty(
        &self,
        name: &str,
        master: Arc<AsyncFd<PtyMaster>>,
        log: Arc<LogFile>,
    ) {
        let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>(WRITE_CHANNEL_CAPACITY);
        let endpoint = AttachEndpoint::new(write_tx);
        self.endpoints
            .lock()
            .await
            .insert(name.to_string(), endpoint.clone());

        tokio::spawn(drain_to_pty(master.clone(), write_rx));
        tokio::spawn(pump_pty(master, endpoint, log));
    }
}

async fn drain_to_stdin(mut stdin: ChildStdin, mut rx: mpsc::Receiver<Vec<u8>>) {
    while let Some(data) = rx.recv().await {
        if stdin.write_all(&data).await.is_err() || stdin.flush().await.is_err() {
            break;
        }
    }
}

async fn pump_stdout(mut stdout: ChildStdout, endpoint: Arc<AttachEndpoint>, log: Arc<LogFile>) {
    let mut buf = [0u8; READ_BUFFER_SIZE];
    loop {
        match stdout.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let bytes = Bytes::copy_from_slice(&buf[..n]);
                log.append(&buf[..n]).await;
                endpoint.publish(bytes).await;
            }
        }
    }
}

// ── PTY ──────────────────────────────────────────────────────────────────────

/// Owns a PTY master fd; closes it on drop. Registered with tokio's `AsyncFd`
/// for readiness-based async I/O over the nonblocking master.
pub struct PtyMaster {
    fd: RawFd,
}

impl AsRawFd for PtyMaster {
    fn as_raw_fd(&self) -> RawFd {
        self.fd
    }
}

impl Drop for PtyMaster {
    fn drop(&mut self) {
        // SAFETY: we own the fd for the endpoint's lifetime.
        unsafe { libc::close(self.fd) };
    }
}

/// The parent's copy of the PTY slave fd. It MUST outlive `Command::spawn()`
/// so the forked child inherits a valid slave to `dup2`/`TIOCSCTTY`; the caller
/// drops it right after spawn to close the parent's copy (which lets the master
/// see hangup when the child exits). Closing it *before* spawn — as this code
/// once did — freed the fd number, which `open()` then reused, so the child's
/// `TIOCSCTTY` hit a regular file (ENOTTY).
pub struct SlaveFd(RawFd);

impl Drop for SlaveFd {
    fn drop(&mut self) {
        // SAFETY: we own this fd until the caller drops the guard post-spawn.
        unsafe { libc::close(self.0) };
    }
}

/// Open a PTY pair, wire a `Command` to run its child on the slave as a session
/// leader with a controlling terminal, and return an async-registered master
/// plus the slave guard. The caller spawns `cmd`, then drops the `SlaveFd`.
/// uid drop runs inside `pre_exec` so it happens after `TIOCSCTTY`.
pub fn setup_pty(
    cmd: &mut Command,
    user: Option<&str>,
) -> std::io::Result<(Arc<AsyncFd<PtyMaster>>, SlaveFd)> {
    let (master, slave) = open_pty()?;
    set_nonblocking(master)?;
    let user = user.map(str::to_string);
    // The child inherits `slave`; std wires stdio via the pre_exec dup2s below.
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    // SAFETY: only async-signal-safe libc calls run in the child before exec.
    unsafe {
        cmd.pre_exec(move || {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::ioctl(slave, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            for target in 0..3 {
                if libc::dup2(slave, target) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            if slave > 2 {
                libc::close(slave);
            }
            libc::close(master);
            if user.as_deref() == Some("dev") {
                if libc::setgid(1000) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::setuid(1000) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    // SAFETY: `master` was just opened and is owned by `PtyMaster`, which never
    // reassigns it and only closes it on drop, after the AsyncFd deregisters.
    let master = Arc::new(unsafe { AsyncFd::register(PtyMaster { fd: master }) }?);
    // Parent keeps the master; the slave guard is closed by the caller *after*
    // spawn so the child inherits it at fork.
    Ok((master, SlaveFd(slave)))
}

fn open_pty() -> std::io::Result<(RawFd, RawFd)> {
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    // SAFETY: openpty fills master/slave; null term settings/winsize = defaults.
    let ret = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut::<libc::c_char>(),
            // *mut null coerces to the *const these take on Linux.
            std::ptr::null_mut::<libc::termios>(),
            std::ptr::null_mut::<libc::winsize>(),
        )
    };
    if ret == 0 {
        Ok((master, slave))
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn set_nonblocking(fd: RawFd) -> std::io::Result<()> {
    // SAFETY: standard F_GETFL/F_SETFL on an owned fd.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

async fn pump_pty(
    master: Arc<AsyncFd<PtyMaster>>,
    endpoint: Arc<AttachEndpoint>,
    log: Arc<LogFile>,
) {
    let mut buf = [0u8; READ_BUFFER_SIZE];
    loop {
        let Ok(mut guard) = master.readable().await else {
            break;
        };
        match guard.try_io(|inner| pty_read(inner.as_raw_fd(), &mut buf)) {
            Ok(Ok(0)) | Ok(Err(_)) => break,
            Ok(Ok(n)) => {
                let bytes = Bytes::copy_from_slice(&buf[..n]);
                log.append(&buf[..n]).await;
                endpoint.publish(bytes).await;
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

pub(crate) fn pty_read(fd: RawFd, buf: &mut [u8]) -> std::io::Result<usize> {
    // SAFETY: fd owned by the AsyncFd guard; buf is valid for len.
    let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
    if n >= 0 {
        Ok(n as usize)
    } else {
        Err(std::io::Error::last_os_error())
    }
}

pub(crate) fn pty_write(fd: RawFd, data: &[u8]) -> std::io::Result<usize> {
    // SAFETY: fd owned by the AsyncFd guard; data is valid for len.
    let n = unsafe { libc::write(fd, data.as_ptr().cast(), data.len()) };
    if n >= 0 {
        Ok(n as usize)
    } else {
        Err(std::io::Error::last_os_error())
    }
}

// ── WebSocket server ─────────────────────────────────────────────────────────

/// Attach WS listener. Two routes share it:
/// - `/attach/{name}` joins a supervised process; `?mode=rw[&takeover=1]` asks
///   for the single writer slot (default read-only), `replay=0` skips the
///   buffered-output replay.
/// - `/terminal/{id}` joins an ad-hoc terminal session (terminal.rs): binary
///   frames are keystrokes, text frames are `{"type":"resize"}` controls, and
///   any number of clients may type.
///
/// Runs on its own port so the runtime can proxy the routes straight through.
/// Every upgrade must carry the agent token (see auth.rs).
pub async fn serve(
    port: u16,
    registry: Arc<AttachRegistry>,
    terminals: Arc<TerminalRegistry>,
    auth: Arc<Auth>,
) {
    let Ok(listener) = TcpListener::bind(("0.0.0.0", port)).await else {
        eprintln!("attach: failed to bind port {port}");
        return;
    };
    println!("attach: WebSocket server listening on port {port}");
    while let Ok((stream, _addr)) = listener.accept().await {
        let mut peek = [0u8; 1024];
        let Ok(n) = stream.peek(&mut peek).await else {
            continue;
        };
        let Some(target) = parse_attach_target(&peek[..n]) else {
            continue;
        };
        let registry = registry.clone();
        let terminals = terminals.clone();
        let auth = auth.clone();
        tokio::spawn(async move {
            handle_conn(stream, target, registry, terminals, auth).await;
        });
    }
}

async fn handle_conn(
    stream: TcpStream,
    target: AttachTarget,
    registry: Arc<AttachRegistry>,
    terminals: Arc<TerminalRegistry>,
    auth: Arc<Auth>,
) {
    // Authorize the upgrade FIRST: an unauthenticated peer gets the same 401
    // whatever the name, so it can't probe which endpoints and terminals
    // exist (an unknown name used to close silently, a known one answered 401).
    let Ok(mut ws) = accept_hdr_async(
        crate::activity::control::Counted::new(stream),
        auth.upgrade_guard(),
    )
    .await
    else {
        return;
    };
    // A terminal session also needs its PTY master (resize target).
    let (endpoint, terminal_master) = if target.terminal {
        let master = terminals.master(&target.name).await;
        match master {
            Some(master) => (
                registry.get(&terminal_key(&target.name)).await,
                Some(master),
            ),
            None => (None, None),
        }
    } else {
        (registry.get(&target.name).await, None)
    };
    let Some(endpoint) = endpoint else {
        // Authenticated, but nothing by that name: close the socket.
        let _ = ws.close(None).await;
        return;
    };
    let (mut sink, mut source) = ws.split();

    // Replay buffered output (unless the client opted out), then subscribe to
    // live output.
    let (chunks, mut rx) = {
        let chunks = if target.replay {
            endpoint.buffer.lock().await.snapshot_chunks()
        } else {
            Vec::new()
        };
        (chunks, endpoint.output.subscribe())
    };
    for chunk in chunks {
        if sink.send(Message::Binary(chunk)).await.is_err() {
            return;
        }
    }

    // Acquire the writer slot if requested; a rejected rw attach degrades to
    // read-only after telling the client. Terminals have no slot.
    let writer_token = if target.writer && terminal_master.is_none() {
        match endpoint.slot.try_acquire(target.takeover).await {
            Some(token) => Some(token),
            None => {
                let _ = sink
                    .send(Message::text(
                        "{\"error\":\"writer slot held; retry with takeover=1\"}",
                    ))
                    .await;
                None
            }
        }
    } else {
        None
    };

    let mut out_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(data) => {
                    if sink.send(Message::Binary(data)).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
                // A lagged client has a gapped stream; disconnect so it
                // reconnects and replays rather than see corruption.
                Err(broadcast::error::RecvError::Lagged(_)) => break,
            }
        }
        let _ = sink.close().await;
    });

    // Only the writer path needs the slot handle.
    let slot = writer_token.map(|token| (endpoint.clone(), token));
    let write_tx = endpoint.write_tx.clone();
    let evict = endpoint.slot.evict_handle();
    let mut in_task = tokio::spawn(async move {
        loop {
            // A writer that got evicted (takeover) stops forwarding input.
            let next = if let Some((ep, token)) = &slot {
                tokio::select! {
                    _ = evict.notified() => {
                        if !ep.slot.is_holder(*token).await { break; }
                        continue;
                    }
                    msg = source.next() => msg,
                }
            } else {
                source.next().await
            };
            let Some(Ok(msg)) = next else { break };
            let data = match msg {
                Message::Binary(b) => Vec::from(b),
                // A terminal's text frames are resize controls; a process's
                // are input bytes.
                Message::Text(t) => match &terminal_master {
                    Some(master) => {
                        crate::terminal::apply_control_frame(master, t.as_bytes());
                        continue;
                    }
                    None => t.as_bytes().to_vec(),
                },
                Message::Close(_) => break,
                _ => continue,
            };
            if terminal_master.is_some() {
                if write_tx.send(data).await.is_err() {
                    break;
                }
                continue;
            }
            // Read-only clients may stream output but never write.
            if let Some((ep, token)) = &slot {
                if !ep.slot.is_holder(*token).await {
                    break;
                }
                if write_tx.send(data).await.is_err() {
                    break;
                }
            }
        }
    });

    tokio::select! {
        _ = &mut out_task => in_task.abort(),
        _ = &mut in_task => out_task.abort(),
    }

    if let Some(token) = writer_token {
        endpoint.slot.release(token).await;
    }
}

/// Registry key of a terminal session's endpoint. Not a valid process name
/// (those are spec names; this carries a `:`), so the two can't collide.
pub fn terminal_key(id: &str) -> String {
    format!("terminal:{id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn single_writer_guard() {
        let slot = WriterSlot::new();
        // First rw attach acquires the slot.
        let a = slot
            .try_acquire(false)
            .await
            .expect("first writer acquires");
        assert!(slot.is_holder(a).await);
        // A second rw attach without takeover is rejected.
        assert!(slot.try_acquire(false).await.is_none());
        assert!(slot.is_holder(a).await, "holder unchanged after rejection");
        // A takeover evicts the first and installs a new holder.
        let b = slot.try_acquire(true).await.expect("takeover acquires");
        assert_ne!(a, b);
        assert!(!slot.is_holder(a).await, "old holder evicted");
        assert!(slot.is_holder(b).await);
        // Releasing a stale token is a no-op; releasing the live one frees it.
        slot.release(a).await;
        assert!(slot.is_holder(b).await);
        slot.release(b).await;
        assert!(!slot.is_holder(b).await);
        // Slot is free again for a fresh writer.
        let c = slot.try_acquire(false).await.expect("free slot acquires");
        assert!(slot.is_holder(c).await);
    }

    /// One upgrade request against `handle_conn` (registries empty), answered
    /// with the raw response text. `token` rides the query like the runtime's
    /// relays do.
    async fn upgrade(path: &str, token: Option<&str>) -> String {
        use crate::store::ConfigStore;

        let registry = AttachRegistry::new();
        let terminals =
            TerminalRegistry::new(Arc::new(ConfigStore::new_for_test(None)), registry.clone());
        let auth = Arc::new(Auth::new(Some("tok".to_string())));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut peek = [0u8; 1024];
            let n = stream.peek(&mut peek).await.unwrap();
            let target = parse_attach_target(&peek[..n]).unwrap();
            handle_conn(stream, target, registry, terminals, auth).await;
        });
        let mut client = TcpStream::connect(addr).await.unwrap();
        let query = token.map(|t| format!("?token={t}")).unwrap_or_default();
        let request = format!(
            "GET {path}{query} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\n\
             Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\
             Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
        );
        client.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            client.read_to_end(&mut response),
        )
        .await;
        server.await.unwrap();
        String::from_utf8_lossy(&response).into_owned()
    }

    #[tokio::test]
    async fn unauthenticated_peers_cannot_probe_names() {
        // An unknown process and an unknown terminal answer exactly as a
        // known one would: 401, whatever the name.
        for path in ["/attach/nope", "/terminal/nope"] {
            let response = upgrade(path, None).await;
            assert!(
                response.starts_with("HTTP/1.1 401"),
                "{path} without a token: {response:?}"
            );
            let wrong = upgrade(path, Some("wrong")).await;
            assert!(wrong.starts_with("HTTP/1.1 401"), "{path}: {wrong:?}");
        }
    }

    #[tokio::test]
    async fn an_authenticated_peer_gets_the_socket_then_a_close_for_an_unknown_name() {
        let response = upgrade("/attach/nope", Some("tok")).await;
        assert!(
            response.starts_with("HTTP/1.1 101"),
            "authorized upgrade: {response:?}"
        );
    }
}
