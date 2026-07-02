//! Readiness probes — the runtime's "is it up?" mechanism, one per
//! `Readiness` variant (config.rs), kept dependency-free to hold the binary
//! size envelope. A probe returns `true` once, and the supervisor latches it.
//!
//! - `port`: a loopback TCP connect succeeds.
//! - `http`: a raw HTTP/1.1 GET returns a 2xx/3xx status line (https falls
//!   back to a TCP connect — TLS would cost a dependency for a liveness gate).
//! - `cmd`: a login shell runs the command and it exits 0.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::Command;

use crate::config::Readiness;
use crate::supervisor::apply_user;

// Capped well under the boot overlay budget so a process that has bound but
// not yet `listen()`ed (connect hangs) can't stall a probe cycle for long.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
const HTTP_READ_TIMEOUT: Duration = Duration::from_millis(1500);

/// Run the probe for a resolved readiness spec. `http_url` is the pre-resolved
/// absolute URL for `Readiness::Http` (config::http_probe_url); `spawn` carries
/// the uid/cwd/env a `cmd` probe inherits from its process.
pub async fn probe(readiness: &Readiness, http_url: Option<&str>, spawn: &ProbeCtx) -> bool {
    match readiness {
        Readiness::Port { port } => probe_port(*port).await,
        Readiness::Http { .. } => match http_url {
            Some(url) => probe_http(url).await,
            None => false,
        },
        Readiness::Cmd { cmd } => probe_cmd(cmd, spawn).await,
    }
}

/// Spawn context a `cmd` probe reuses so the check runs as the same principal,
/// cwd, and env as the process it gates.
#[derive(Default)]
pub struct ProbeCtx {
    pub user: Option<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
}

async fn probe_port(port: u16) -> bool {
    matches!(
        tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(("127.0.0.1", port))).await,
        Ok(Ok(_))
    )
}

async fn probe_http(url: &str) -> bool {
    let Some((host, port, path, is_tls)) = parse_url(url) else {
        return false;
    };
    // No TLS stack in the agent: a TLS endpoint degrades to a connect check.
    if is_tls {
        return probe_port(port).await;
    }
    let Ok(Ok(mut stream)) =
        tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host.as_str(), port))).await
    else {
        return false;
    };
    let req =
        format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nAccept: */*\r\n\r\n");
    if stream.write_all(req.as_bytes()).await.is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let read = tokio::time::timeout(HTTP_READ_TIMEOUT, stream.read(&mut buf)).await;
    let Ok(Ok(n)) = read else { return false };
    // Status line: "HTTP/1.1 200 OK". Accept 2xx and 3xx.
    let line = String::from_utf8_lossy(&buf[..n]);
    line.split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .is_some_and(|code| (200..400).contains(&code))
}

async fn probe_cmd(cmd: &str, ctx: &ProbeCtx) -> bool {
    // Non-login shell: a readiness probe runs every cycle, so skip the
    // `/etc/profile` + rc sourcing a login shell pays on each invocation.
    let mut command = Command::new("/bin/bash");
    command.args(["-c", cmd]);
    apply_user(&mut command, ctx.user.as_deref().unwrap_or("root"));
    if let Some(dir) = &ctx.cwd {
        command.current_dir(dir);
    }
    for (k, v) in &ctx.env {
        command.env(k, v);
    }
    matches!(command.status().await, Ok(status) if status.success())
}

/// Minimal `http(s)://host[:port]/path` split — no query/userinfo handling
/// beyond what a readiness URL needs. Returns (host, port, path, is_tls).
fn parse_url(url: &str) -> Option<(String, u16, String, bool)> {
    let (is_tls, rest) = if let Some(r) = url.strip_prefix("https://") {
        (true, r)
    } else {
        (false, url.strip_prefix("http://")?)
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse::<u16>().ok()?),
        None => (authority.to_string(), if is_tls { 443 } else { 80 }),
    };
    if host.is_empty() {
        return None;
    }
    Some((host, port, path.to_string(), is_tls))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_loopback_url() {
        let (host, port, path, tls) = parse_url("http://127.0.0.1:5173/health").unwrap();
        assert_eq!(host, "127.0.0.1");
        assert_eq!(port, 5173);
        assert_eq!(path, "/health");
        assert!(!tls);
    }

    #[test]
    fn defaults_port_and_path() {
        let (host, port, path, tls) = parse_url("http://example.com").unwrap();
        assert_eq!(host, "example.com");
        assert_eq!(port, 80);
        assert_eq!(path, "/");
        assert!(!tls);
        assert_eq!(parse_url("https://x/y").unwrap().1, 443);
    }

    #[test]
    fn rejects_non_http() {
        assert!(parse_url("ftp://x/y").is_none());
        assert!(parse_url("http:///nohost").is_none());
    }

    #[tokio::test]
    async fn port_probe_detects_listener() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(probe_port(port).await);
    }

    #[tokio::test]
    async fn port_probe_fails_closed() {
        // Bind then drop to get an almost-certainly-free port.
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!probe_port(port).await);
    }
}
