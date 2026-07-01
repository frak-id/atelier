//! Atelier v2 in-pod agent (`atelier-agent`). Parallel-track fork of
//! `sandbox-agent` (apps/agent-rust) against the v2 `SandboxSpec` seam:
//! config is *pushed* by the runtime and mutable (store.rs), processes are
//! supervised agent-side with readiness/primary/after/restart/lazy semantics,
//! and stdio/PTY attach share one bridge with a single-writer guard.
//!
//! Milestone 1 build order (atelier-v2 §6 phase 1):
//!   1a. crate + config schema + mutable store + config push route  ← this commit
//!   1b. supervisor (autostart, readiness probes, restart, after, lazy)
//!   1c. unified attach bridge with single-writer guard + PTY
//!   1d. phased hooks + N-port forwarder + exec/files routes

mod config;
mod router;
mod store;

use std::sync::Arc;

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

use store::ConfigStore;

pub const AGENT_PORT: u16 = 9998;

#[tokio::main]
async fn main() {
    println!("atelier-agent starting...");

    let store = Arc::new(ConfigStore::load());
    match store.get() {
        Some(cfg) => println!(
            "atelier-agent: recovered config for sandbox {}",
            cfg.sandbox_id
        ),
        None => println!("atelier-agent: no config yet; waiting for runtime push"),
    }

    // Level-triggered reconcile stub: 1b replaces the log line with the
    // supervisor's reconcile-against-desired-state pass.
    {
        let store = store.clone();
        let mut rx = store.subscribe();
        tokio::spawn(async move {
            while rx.changed().await.is_ok() {
                let version = *rx.borrow();
                if let Some(cfg) = store.get() {
                    println!(
                        "atelier-agent: config v{version} applied ({} processes)",
                        cfg.processes.len()
                    );
                }
            }
        });
    }

    let addr = format!("0.0.0.0:{AGENT_PORT}");
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("atelier-agent: failed to bind {addr}: {e}");
            return;
        }
    };
    println!("atelier-agent: listening on {addr}");

    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                eprintln!("atelier-agent: accept error: {e}");
                continue;
            }
        };
        let store = store.clone();
        tokio::spawn(async move {
            let io = TokioIo::new(stream);
            let service = service_fn(move |req| {
                let store = store.clone();
                async move { Ok::<_, std::convert::Infallible>(router::route(req, store).await) }
            });
            if let Err(e) = http1::Builder::new().serve_connection(io, service).await
                && !e.is_incomplete_message()
            {
                eprintln!("atelier-agent: connection error: {e}");
            }
        });
    }
}
