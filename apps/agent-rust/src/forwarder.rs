use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
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
            Err(_) => {
                // accept() fails transiently under fd exhaustion (EMFILE); a
                // bare `continue` would spin a core, so back off first.
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        tokio::spawn(handle_conn(inbound, target_port));
    }
}

async fn handle_conn(mut inbound: TcpStream, target_port: u16) {
    // Retry briefly so a click immediately after "start" waits for the dev
    // server to bind. If it never comes up, answer with a 502 rather than
    // dropping the socket (which renders as an opaque browser error).
    let Some(mut outbound) = connect_with_retry(target_port, Duration::from_secs(5)).await else {
        write_bad_gateway(&mut inbound).await;
        return;
    };
    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
}

async fn write_bad_gateway(inbound: &mut TcpStream) {
    let body = "Dev server is not running\n";
    let response = format!(
        "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = inbound.write_all(response.as_bytes()).await;
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
