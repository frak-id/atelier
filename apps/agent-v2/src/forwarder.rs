//! Generic N-port forwarder. Dev servers (Vite, Astro, etc.) bind loopback
//! (`127.0.0.1` or `::1`, whatever `localhost` resolves to), which the K8s
//! Service — targeting the pod IP — can't reach. The forwarder bridges each
//! `ports[]` entry from outside to that loopback, so no HOST/bind config is
//! needed in the user's tooling.
//!
//! Two modes, by who serves the port:
//!
//! - **Unowned** (no process declares a `readiness.port` on it: a dev server
//!   the user starts by hand): listen on `0.0.0.0:<port>` from the start.
//! - **Owned** (a supervised process probes it): never pre-bind. Some tools
//!   (code-server, KasmVNC) bind `0.0.0.0:<port>` themselves, and a squatted
//!   address would fail their bind with EADDRINUSE. Instead, watch: once the
//!   process listens on loopback while the pod IP refuses, bind
//!   `<pod IP>:<port>` (the one address the process left free) and bridge.
//!   A tool on `0.0.0.0` is reachable already and is left alone.
//!
//! v1 hardcoded a single dev-port forwarder; v2 reconciles a task per
//! `ports[]` entry against every pushed config, symmetric with the
//! supervisor's config-watch: a re-pushed config (spec update, resume) that
//! adds or drops a port adds or drops its task.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
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
/// How often an owned port is checked for a loopback-only bind.
const OWNED_POLL: Duration = Duration::from_secs(1);
const PROBE_TIMEOUT: Duration = Duration::from_millis(300);

const LOOPBACK_V4: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
const LOOPBACK_V6: IpAddr = IpAddr::V6(Ipv6Addr::LOCALHOST);

/// Owns one task per active forwarded port, keyed by port number, with the
/// mode it runs in (an ownership change restarts it).
pub struct Forwarder {
    active: Mutex<HashMap<u16, (bool, JoinHandle<()>)>>,
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

    /// Start tasks for newly-declared ports, drop those no longer present.
    async fn reconcile(&self, store: &Arc<ConfigStore>) {
        let Some(cfg) = store.get() else { return };
        let owned: Vec<u16> = cfg
            .processes
            .iter()
            .filter_map(|p| match p.readiness {
                Some(crate::config::Readiness::Port { port }) => Some(port),
                _ => None,
            })
            .collect();
        let desired: HashMap<u16, bool> = cfg
            .ports
            .iter()
            .map(|p| (p.port, owned.contains(&p.port)))
            .collect();
        let mut active = self.active.lock().await;
        active.retain(|port, (is_owned, handle)| {
            let keep = desired.get(port) == Some(is_owned);
            if !keep {
                handle.abort();
            }
            keep
        });
        for (port, is_owned) in desired {
            active.entry(port).or_insert_with(|| {
                let task = if is_owned {
                    tokio::spawn(bridge_owned(port))
                } else {
                    tokio::spawn(listen(port))
                };
                (is_owned, task)
            });
        }
    }
}

/// Unowned port: listen on every interface from the start, bridge to
/// whichever loopback the server binds (`::1` first: a connect to
/// `127.0.0.1` could land on this very listener).
async fn listen(port: u16) {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port);
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("forwarder: failed to bind {addr}: {e}");
            return;
        }
    };
    println!("forwarder: {addr} -> loopback:{port}");
    let targets = vec![
        SocketAddr::new(LOOPBACK_V6, port),
        SocketAddr::new(LOOPBACK_V4, port),
    ];
    serve(listener, targets).await;
}

/// Owned port: wait for the process to listen on loopback only, then bind
/// the pod IP it left free and bridge to its loopback. Released once the
/// process stops listening, so a restart that binds `0.0.0.0` itself (a
/// `--host` added to its command) finds the address free.
async fn bridge_owned(port: u16) {
    let targets = vec![
        SocketAddr::new(LOOPBACK_V4, port),
        SocketAddr::new(LOOPBACK_V6, port),
    ];
    loop {
        tokio::time::sleep(OWNED_POLL).await;
        let Some(ip) = pod_ip() else { continue };
        if let Some(listener) = bind_if_loopback_only(ip, port).await {
            println!("forwarder: {ip}:{port} -> loopback:{port} (owned)");
            tokio::select! {
                () = serve(listener, targets.clone()) => {}
                () = upstream_gone(port) => {
                    println!("forwarder: released {ip}:{port}");
                }
            }
        }
    }
}

/// Resolves once nothing listens on either loopback for `port`.
async fn upstream_gone(port: u16) {
    loop {
        tokio::time::sleep(OWNED_POLL).await;
        let up = accepts(SocketAddr::new(LOOPBACK_V4, port)).await
            || accepts(SocketAddr::new(LOOPBACK_V6, port)).await;
        if !up {
            return;
        }
    }
}

/// `external:port` bound for a bridge when the server listens on a loopback
/// but not on `external` (it bound loopback only), else `None` (not up yet,
/// or reachable directly).
async fn bind_if_loopback_only(external: IpAddr, port: u16) -> Option<TcpListener> {
    let on_loopback = accepts(SocketAddr::new(LOOPBACK_V4, port)).await
        || accepts(SocketAddr::new(LOOPBACK_V6, port)).await;
    if !on_loopback || accepts(SocketAddr::new(external, port)).await {
        return None;
    }
    // A bind error means something took it meanwhile: re-check next tick.
    TcpListener::bind(SocketAddr::new(external, port))
        .await
        .ok()
}

async fn accepts(addr: SocketAddr) -> bool {
    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, TcpStream::connect(addr)).await,
        Ok(Ok(_))
    )
}

/// The pod's primary address (the one its Service routes to): the source
/// address of the default route, read by "connecting" a UDP socket, which
/// sends nothing.
fn pod_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("10.255.255.255:1").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

async fn serve(listener: TcpListener, targets: Vec<SocketAddr>) {
    let targets = Arc::new(targets);
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
        tokio::spawn(handle_conn(inbound, targets.clone()));
    }
}

async fn handle_conn(mut inbound: TcpStream, targets: Arc<Vec<SocketAddr>>) {
    // Retry briefly so a click right after "start" waits for the server to
    // bind. If it never comes up, answer 502 rather than dropping the socket
    // (which renders as an opaque browser error).
    let Some(mut outbound) = connect_with_retry(&targets).await else {
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

async fn connect_with_retry(targets: &[SocketAddr]) -> Option<TcpStream> {
    let start = Instant::now();
    loop {
        for target in targets {
            if let Ok(stream) = TcpStream::connect(target).await {
                return Some(stream);
            }
        }
        if start.elapsed() >= CONNECT_WINDOW {
            return None;
        }
        tokio::time::sleep(CONNECT_RETRY).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    /// A server bound to `::1` only, like `astro dev` on `localhost`.
    async fn v6_only_server() -> Option<(u16, JoinHandle<()>)> {
        let listener = TcpListener::bind("[::1]:0").await.ok()?;
        let port = listener.local_addr().ok()?.port();
        let task = tokio::spawn(async move {
            while let Ok((mut s, _)) = listener.accept().await {
                let _ = s.write_all(b"hi").await;
            }
        });
        Some((port, task))
    }

    #[tokio::test]
    async fn bridges_a_loopback_only_server() {
        // No IPv6 loopback on this host: nothing to test.
        let Some((port, _server)) = v6_only_server().await else {
            return;
        };
        // 127.0.0.1 stands in for the pod IP: the server isn't on it.
        let listener = bind_if_loopback_only(LOOPBACK_V4, port)
            .await
            .expect("bound the address the server left free");
        tokio::spawn(serve(listener, vec![SocketAddr::new(LOOPBACK_V6, port)]));
        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, port))
            .await
            .unwrap();
        let mut buf = [0u8; 2];
        client.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hi");
    }

    #[tokio::test]
    async fn leaves_a_directly_reachable_or_absent_server_alone() {
        // Bound on the "external" address itself: nothing to bridge.
        let direct = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = direct.local_addr().unwrap().port();
        assert!(bind_if_loopback_only(LOOPBACK_V4, port).await.is_none());
        drop(direct);
        // Nothing listening: not up yet.
        assert!(bind_if_loopback_only(LOOPBACK_V4, port).await.is_none());
    }
}
