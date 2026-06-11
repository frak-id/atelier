use std::time::{Duration, Instant};
use tokio::net::{TcpListener, TcpStream};

// Dev servers (notably Vite) bind 127.0.0.1, unreachable from the K8s Service
// which targets the pod IP. This forwarder accepts on 0.0.0.0:<listen> and
// bridges to 127.0.0.1:<target> over loopback, so no HOST/bind config is
// needed in the user's tooling.
pub async fn run(listen_port: u16, target_port: u16) {
    let addr = format!("0.0.0.0:{listen_port}");
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("dev forwarder failed to bind {addr}: {e}");
            return;
        }
    };
    println!("dev forwarder listening on {addr} -> 127.0.0.1:{target_port}");

    loop {
        let inbound = match listener.accept().await {
            Ok((stream, _peer)) => stream,
            Err(_) => continue,
        };
        tokio::spawn(handle_conn(inbound, target_port));
    }
}

async fn handle_conn(mut inbound: TcpStream, target_port: u16) {
    // Retry briefly so a click immediately after "start" waits for the dev
    // server to bind instead of returning a hard 502.
    let Some(mut outbound) = connect_with_retry(target_port, Duration::from_secs(5)).await else {
        return;
    };
    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
}

async fn connect_with_retry(port: u16, window: Duration) -> Option<TcpStream> {
    let start = Instant::now();
    loop {
        if let Ok(stream) = TcpStream::connect(("127.0.0.1", port)).await {
            return Some(stream);
        }
        if start.elapsed() >= window {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}
