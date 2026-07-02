//! Generic N-port forwarder. Dev servers (Vite, etc.) bind 127.0.0.1, which the
//! K8s Service — targeting the pod IP — can't reach. For every `ports[]` entry
//! the forwarder accepts on `0.0.0.0:<port>` and bridges to `127.0.0.1:<port>`,
//! so no HOST/bind config is needed in the user's tooling.
//!
//! v1 hardcoded a single dev-port forwarder; v2 reconciles a listener per
//! `ports[]` entry against every pushed config, symmetric with the supervisor's
//! config-watch: a re-pushed config (spec update, resume) that adds or drops a
//! port adds or drops its listener. Ported from apps/agent-rust forwarder.rs.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::store::ConfigStore;

const CONNECT_WINDOW: Duration = Duration::from_secs(5);
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);
const CONNECT_RETRY: Duration = Duration::from_millis(200);

/// Owns one accept-loop task per active forwarded port, keyed by port number.
pub struct Forwarder {
    active: Mutex<HashMap<u16, JoinHandle<()>>>,
}

impl Forwarder {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            active: Mutex::new(HashMap::new()),
        })
    }

    /// Watch the config and reconcile listeners on every change (level-
    /// triggered). Runs until the store is dropped.
    pub async fn run(self: Arc<Self>, store: Arc<ConfigStore>) {
        let mut rx = store.subscribe();
        if store.get().is_some() {
            self.reconcile(&store).await;
        }
        while rx.changed().await.is_ok() {
            self.reconcile(&store).await;
        }
    }

    /// Start listeners for newly-declared ports, drop those no longer present.
    async fn reconcile(&self, store: &Arc<ConfigStore>) {
        let Some(cfg) = store.get() else { return };
        let desired: Vec<u16> = cfg.ports.iter().map(|p| p.port).collect();
        let mut active = self.active.lock().await;
        active.retain(|port, handle| {
            let keep = desired.contains(port);
            if !keep {
                handle.abort();
            }
            keep
        });
        for port in desired {
            active
                .entry(port)
                .or_insert_with(|| tokio::spawn(listen(port)));
        }
    }
}

async fn listen(port: u16) {
    let addr = format!("0.0.0.0:{port}");
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("forwarder: failed to bind {addr}: {e}");
            return;
        }
    };
    println!("forwarder: {addr} -> 127.0.0.1:{port}");
    loop {
        let inbound = match listener.accept().await {
            Ok((stream, _peer)) => stream,
            Err(_) => {
                // accept() fails transiently under fd exhaustion (EMFILE); a
                // bare continue would spin a core, so back off first.
                tokio::time::sleep(ACCEPT_BACKOFF).await;
                continue;
            }
        };
        tokio::spawn(handle_conn(inbound, port));
    }
}

async fn handle_conn(mut inbound: TcpStream, target_port: u16) {
    // Retry briefly so a click right after "start" waits for the server to
    // bind. If it never comes up, answer 502 rather than dropping the socket
    // (which renders as an opaque browser error).
    let Some(mut outbound) = connect_with_retry(target_port).await else {
        write_bad_gateway(&mut inbound).await;
        return;
    };
    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
}

async fn write_bad_gateway(inbound: &mut TcpStream) {
    let body = "Upstream server is not running\n";
    let response = format!(
        "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = inbound.write_all(response.as_bytes()).await;
}

async fn connect_with_retry(port: u16) -> Option<TcpStream> {
    let start = Instant::now();
    loop {
        if let Ok(stream) = TcpStream::connect(("127.0.0.1", port)).await {
            return Some(stream);
        }
        if start.elapsed() >= CONNECT_WINDOW {
            return None;
        }
        tokio::time::sleep(CONNECT_RETRY).await;
    }
}
