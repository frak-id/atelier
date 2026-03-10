mod body;
mod command;
mod config;
mod limits;
mod response;
mod router;
mod routes;
mod terminal;
mod watchdog;

use std::convert::Infallible;
use std::time::SystemTime;

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use nix::sys::wait::{waitpid, WaitPidFlag};
use nix::unistd::Pid;
use tokio::net::TcpListener;

use config::AGENT_PORT;

pub fn utc_rfc3339() -> String {
    let dur = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();

    let days = secs / 86400;
    let rem = secs % 86400;
    let hours = rem / 3600;
    let minutes = (rem % 3600) / 60;
    let seconds = rem % 60;

    // Civil date from days since 1970-01-01 (algorithm from Howard Hinnant)
    let z = days as i64 + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y, m, d, hours, minutes, seconds
    )
}

async fn handle(req: Request<hyper::body::Incoming>) -> Result<Response<Full<Bytes>>, Infallible> {
    Ok(router::route(req).await)
}

fn reap_zombies() {
    loop {
        match waitpid(Pid::from_raw(-1), Some(WaitPidFlag::WNOHANG)) {
            Ok(nix::sys::wait::WaitStatus::StillAlive) => break,
            Ok(_) => continue,
            Err(_) => break,
        }
    }
}

fn start_zombie_reaper() {
    tokio::spawn(async {
        let mut sigchld =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child())
                .expect("failed to register SIGCHLD handler");
        loop {
            sigchld.recv().await;
            reap_zombies();
        }
    });
}

#[tokio::main]
async fn main() {
    println!("Sandbox agent starting...");

    watchdog::start();
    start_zombie_reaper();

    let addr = format!("0.0.0.0:{AGENT_PORT}");
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Failed to bind TCP port {AGENT_PORT}: {e}");
            return;
        }
    };
    println!("Listening on {addr}");

    // Services are started by the manager after config push via POST /services/{name}/start
    // tokio::spawn(async {
    //     routes::services::start_autostart_services().await;
    // });

    tokio::spawn(async {
        terminal::ensure_terminal_from_config().await;
    });

    loop {
        let (stream, _addr) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                eprintln!("TCP accept error: {e}");
                continue;
            }
        };
        tokio::spawn(async move {
            let io = TokioIo::new(stream);
            if let Err(e) = http1::Builder::new()
                .serve_connection(io, service_fn(handle))
                .await
            {
                if !e.is_incomplete_message() {
                    eprintln!("connection error: {e}");
                }
            }
        });
    }
}
