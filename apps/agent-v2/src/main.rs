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

mod attach;
mod bridge;
mod command;
mod config;
mod files;
mod forwarder;
mod hooks;
mod limits;
mod readiness;
mod router;
mod store;
mod supervisor;
mod terminal;
mod toolset;

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

use forwarder::Forwarder;
use store::ConfigStore;
use supervisor::Supervisor;
use terminal::TerminalRegistry;

pub const AGENT_PORT: u16 = 9998;

/// UTC RFC3339 timestamp with no chrono dependency (civil-date algorithm from
/// Howard Hinnant), ported from apps/agent-rust main.rs.
pub fn now_rfc3339() -> String {
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let (days, rem) = (secs / 86400, secs % 86400);
    let (hours, minutes, seconds) = (rem / 3600, (rem % 3600) / 60, rem % 60);
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
    format!("{y:04}-{m:02}-{d:02}T{hours:02}:{minutes:02}:{seconds:02}Z")
}

#[tokio::main]
async fn main() {
    println!("atelier-agent starting...");

    let store = Arc::new(ConfigStore::load());
    let supervisor = Supervisor::new(store.clone());
    let terminals = TerminalRegistry::new(store.clone());

    // Interactive terminal WS relay (ad-hoc login shells) on its own port, so
    // the runtime proxies WS /sandboxes/:id/terminal/sessions/:sid/ws through.
    {
        let terminals = terminals.clone();
        tokio::spawn(async move {
            terminal::serve(terminal::TERMINAL_PORT, terminals).await;
        });
    }

    // Attach WS server (stdio-bridge + PTY relay) on its own port so the
    // runtime can proxy WS /v1/sandboxes/:id/attach/:name straight through.
    {
        let registry = supervisor.attach_registry();
        tokio::spawn(async move {
            attach::serve(attach::ATTACH_PORT, registry).await;
        });
    }
    match store.get() {
        Some(cfg) => println!(
            "atelier-agent: recovered config for sandbox {}",
            cfg.sandbox_id
        ),
        None => println!("atelier-agent: no config yet; waiting for runtime push"),
    }

    // Generic N-port forwarder: exposes each ports[] entry on 0.0.0.0 so the
    // K8s Service reaches loopback-bound dev servers. Reconciles on push.
    {
        let store = store.clone();
        tokio::spawn(async move {
            Forwarder::new().run(store).await;
        });
    }

    // Crash-restart recovery: a persisted config means the agent restarted
    // within a live pod, so bring its processes back up once. A fresh,
    // runtime-driven boot instead pushes config *without* autostarting, then
    // drives the fixed phase order explicitly (files/write -> POST
    // /hooks/postCreate -> POST /reconcile -> POST /hooks/postStart) so
    // postCreate always precedes the process phase.
    if store.get().is_some() {
        let supervisor = supervisor.clone();
        tokio::spawn(async move {
            supervisor.reconcile().await;
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
        let supervisor = supervisor.clone();
        let terminals = terminals.clone();
        tokio::spawn(async move {
            let io = TokioIo::new(stream);
            let service = service_fn(move |req| {
                let store = store.clone();
                let supervisor = supervisor.clone();
                let terminals = terminals.clone();
                async move {
                    Ok::<_, std::convert::Infallible>(
                        router::route(req, store, supervisor, terminals).await,
                    )
                }
            });
            if let Err(e) = http1::Builder::new().serve_connection(io, service).await
                && !e.is_incomplete_message()
            {
                eprintln!("atelier-agent: connection error: {e}");
            }
        });
    }
}
