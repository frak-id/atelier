//! HTTP control plane on :9998. Surface: health, config push/read, supervised
//! process control, phased hooks, one-shot exec, and file writes.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::{Method, Request, Response, StatusCode};
use serde::Deserialize;

use crate::command::{self, DEFAULT_EXEC_TIMEOUT_MS};
use crate::config::AgentConfig;
use crate::files::{self, WriteFilesRequest};
use crate::hooks::{self, Phase};
use crate::limits::{EXEC_SEMAPHORE, FILES_SEMAPHORE, MAX_REQUEST_BODY_BYTES};
use crate::store::ConfigStore;
use crate::supervisor::Supervisor;
use crate::terminal::{CreateRequest, TerminalRegistry};

/// Config bodies are runtime-authored (spec-sized), not user uploads.
const MAX_CONFIG_BODY_BYTES: usize = 4 * 1024 * 1024;

pub async fn route(
    req: Request<hyper::body::Incoming>,
    store: Arc<ConfigStore>,
    supervisor: Arc<Supervisor>,
    terminals: Arc<TerminalRegistry>,
) -> Response<Full<Bytes>> {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    let start = *START.get_or_init(Instant::now);

    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();

    match (&method, path.as_str()) {
        // `healthy` reflects the spec's `primary` process readiness — the
        // generic, harness-agnostic boot gate (any process can be `primary`).
        (&Method::GET, "/health") => json(
            StatusCode::OK,
            serde_json::json!({
                "status": "ok",
                "uptime": start.elapsed().as_secs_f64(),
                "configured": store.get().is_some(),
                "healthy": supervisor.is_healthy().await,
            }),
        ),
        (&Method::GET, "/config") => match store.get() {
            Some(cfg) => json(
                StatusCode::OK,
                serde_json::to_value(cfg.as_ref()).unwrap_or_default(),
            ),
            None => error(StatusCode::NOT_FOUND, "No config pushed yet"),
        },
        (&Method::PUT, "/config") => handle_put_config(req, store).await,
        (&Method::GET, "/processes") => json(
            StatusCode::OK,
            serde_json::json!({ "processes": supervisor.list().await }),
        ),
        // Start all non-lazy processes not already running. The runtime calls
        // this as the "processes" phase, after files/write + postCreate. A
        // config push alone never autostarts (crash-recovery excepted).
        (&Method::POST, "/reconcile") => {
            supervisor.reconcile().await;
            json(StatusCode::OK, serde_json::json!({ "success": true }))
        }
        // One-shot exec + phased hooks + file writes (1d).
        (&Method::POST, "/exec") => handle_exec(req, &store).await,
        (&Method::POST, "/exec/batch") => handle_exec_batch(req, &store).await,
        (&Method::POST, "/files/write") => handle_write_files(req).await,
        // Build+push a toolset artifact from declared home path-sets (the
        // runtime drives this in a throwaway build pod; the tail of the
        // toolset build path — composed-prebuild-volumes.md §2).
        (&Method::POST, "/toolsets/build") => handle_toolset_build(req).await,
        // Capture a live sandbox's declared path-sets into a toolset artifact
        // (secret-scanned, exclude-filtered) — composed-prebuild-volumes.md §2
        // "captured (result-keyed)".
        (&Method::POST, "/toolsets/capture") => handle_toolset_capture(req).await,
        // Materialize toolset artifacts into the home (runtime drives this as
        // a boot phase before files/env, fresh boots only).
        (&Method::POST, "/toolsets") => handle_toolset_materialize(req).await,
        // Interactive terminal sessions (byte relay + resize on port 7681).
        (&Method::GET, "/terminal/sessions") => json(
            StatusCode::OK,
            serde_json::to_value(terminals.list().await).unwrap_or_default(),
        ),
        (&Method::POST, "/terminal/sessions") => handle_terminal_create(req, &terminals).await,
        _ if method == Method::POST && path.starts_with("/hooks/") => {
            handle_hooks(&path, &store).await
        }
        _ if path.starts_with("/terminal/sessions/") => {
            route_terminal_session(&method, &path, &terminals).await
        }
        _ => route_process(&method, &path, &query, &supervisor).await,
    }
}

/// Parse a `u64` query param (e.g. `offset`, `limit`) from a raw query string,
/// falling back to `default` when absent or malformed.
fn query_u64(query: &str, key: &str, default: u64) -> u64 {
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix(key)?.strip_prefix('='))
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// Pod env (with resolved secrets) that exec/hooks run under; empty if no
/// config has been pushed yet.
fn pod_env(store: &Arc<ConfigStore>) -> HashMap<String, String> {
    store.get().map(|c| c.env.clone()).unwrap_or_default()
}

#[derive(Deserialize)]
struct ExecBody {
    command: String,
    timeout: Option<u64>,
    user: Option<String>,
    workdir: Option<String>,
}

async fn handle_exec(
    req: Request<hyper::body::Incoming>,
    store: &Arc<ConfigStore>,
) -> Response<Full<Bytes>> {
    let _permit = EXEC_SEMAPHORE.acquire().await.expect("exec semaphore");
    let body = match read_body(req, MAX_REQUEST_BODY_BYTES).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let parsed: ExecBody = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(e) => return error(StatusCode::BAD_REQUEST, &format!("Invalid JSON: {e}")),
    };
    let result = command::run(
        &parsed.command,
        parsed.timeout.unwrap_or(DEFAULT_EXEC_TIMEOUT_MS),
        parsed.user.as_deref(),
        parsed.workdir.as_deref(),
        &pod_env(store),
        command::MAX_COMMAND_OUTPUT_BYTES,
    )
    .await;
    json(
        StatusCode::OK,
        serde_json::to_value(result).unwrap_or_default(),
    )
}

#[derive(Deserialize)]
struct BatchCommand {
    id: String,
    command: String,
    timeout: Option<u64>,
    user: Option<String>,
    workdir: Option<String>,
}

#[derive(Deserialize)]
struct BatchBody {
    commands: Vec<BatchCommand>,
}

async fn handle_exec_batch(
    req: Request<hyper::body::Incoming>,
    store: &Arc<ConfigStore>,
) -> Response<Full<Bytes>> {
    let body = match read_body(req, MAX_REQUEST_BODY_BYTES).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let parsed: BatchBody = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(e) => return error(StatusCode::BAD_REQUEST, &format!("Invalid JSON: {e}")),
    };
    let env = Arc::new(pod_env(store));
    let mut set = tokio::task::JoinSet::new();
    for cmd in parsed.commands {
        let env = env.clone();
        set.spawn(async move {
            let _permit = EXEC_SEMAPHORE.acquire().await.expect("exec semaphore");
            let result = command::run(
                &cmd.command,
                cmd.timeout.unwrap_or(DEFAULT_EXEC_TIMEOUT_MS),
                cmd.user.as_deref(),
                cmd.workdir.as_deref(),
                &env,
                command::MAX_COMMAND_OUTPUT_BYTES,
            )
            .await;
            let mut value = serde_json::to_value(result).unwrap_or_default();
            if let Some(obj) = value.as_object_mut() {
                obj.insert("id".into(), serde_json::Value::String(cmd.id));
            }
            value
        });
    }
    let mut results = Vec::with_capacity(set.len());
    while let Some(Ok(value)) = set.join_next().await {
        results.push(value);
    }
    json(StatusCode::OK, serde_json::json!({ "results": results }))
}

/// `POST /hooks/{phase}` runs the config's commands for that lifecycle phase
/// (mechanism); the runtime decides when to fire each phase (policy).
async fn handle_hooks(path: &str, store: &Arc<ConfigStore>) -> Response<Full<Bytes>> {
    let name = path.strip_prefix("/hooks/").unwrap_or_default();
    let Some(phase) = Phase::parse(name) else {
        return error(StatusCode::NOT_FOUND, "Unknown hook phase");
    };
    let Some(cfg) = store.get() else {
        return error(StatusCode::SERVICE_UNAVAILABLE, "no config");
    };
    let result = hooks::run_phase(phase, &cfg.hooks, &cfg.env).await;
    let status = if result.success {
        StatusCode::OK
    } else {
        StatusCode::UNPROCESSABLE_ENTITY
    };
    json(status, serde_json::to_value(result).unwrap_or_default())
}

async fn handle_toolset_build(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let body = match read_body(req, MAX_REQUEST_BODY_BYTES).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let parsed: crate::toolset::BuildRequest = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(e) => return error(StatusCode::BAD_REQUEST, &format!("Invalid JSON: {e}")),
    };
    match crate::toolset::build(parsed).await {
        Ok(result) => json(
            StatusCode::OK,
            serde_json::to_value(result).unwrap_or_default(),
        ),
        Err(e) => error(StatusCode::UNPROCESSABLE_ENTITY, &e),
    }
}

async fn handle_toolset_capture(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let body = match read_body(req, MAX_REQUEST_BODY_BYTES).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let parsed: crate::toolset::CaptureRequest = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(e) => return error(StatusCode::BAD_REQUEST, &format!("Invalid JSON: {e}")),
    };
    match crate::toolset::capture(parsed).await {
        Ok(result) => json(
            StatusCode::OK,
            serde_json::to_value(result).unwrap_or_default(),
        ),
        Err(e) => error(StatusCode::UNPROCESSABLE_ENTITY, &e),
    }
}

async fn handle_toolset_materialize(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let body = match read_body(req, MAX_REQUEST_BODY_BYTES).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let parsed: crate::toolset::MaterializeRequest = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(e) => return error(StatusCode::BAD_REQUEST, &format!("Invalid JSON: {e}")),
    };
    match crate::toolset::materialize(parsed).await {
        Ok(result) => json(
            StatusCode::OK,
            serde_json::to_value(result).unwrap_or_default(),
        ),
        Err(e) => error(StatusCode::UNPROCESSABLE_ENTITY, &e),
    }
}

async fn handle_write_files(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let _permit = FILES_SEMAPHORE.acquire().await.expect("files semaphore");
    let body = match read_body(req, MAX_REQUEST_BODY_BYTES).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let parsed: WriteFilesRequest = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(e) => return error(StatusCode::BAD_REQUEST, &format!("Invalid JSON: {e}")),
    };
    let results = files::write_files(parsed).await;
    let status = if results.iter().all(|r| r.success) {
        StatusCode::OK
    } else {
        StatusCode::MULTI_STATUS
    };
    json(status, serde_json::json!({ "results": results }))
}

/// `POST /terminal/sessions` — spawn a login shell on a fresh PTY, returning
/// its `TerminalSession` metadata. The WS byte relay lives on port 7681.
async fn handle_terminal_create(
    req: Request<hyper::body::Incoming>,
    terminals: &Arc<TerminalRegistry>,
) -> Response<Full<Bytes>> {
    let body = match read_body(req, MAX_REQUEST_BODY_BYTES).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let parsed: CreateRequest = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(e) => return error(StatusCode::BAD_REQUEST, &format!("Invalid JSON: {e}")),
    };
    match terminals.create(parsed).await {
        Ok(meta) => json(
            StatusCode::OK,
            serde_json::to_value(meta).unwrap_or_default(),
        ),
        Err(e) => error(StatusCode::UNPROCESSABLE_ENTITY, &e),
    }
}

/// `GET|DELETE /terminal/sessions/{id}` — inspect or kill one shell.
async fn route_terminal_session(
    method: &Method,
    path: &str,
    terminals: &Arc<TerminalRegistry>,
) -> Response<Full<Bytes>> {
    let id = path.strip_prefix("/terminal/sessions/").unwrap_or_default();
    if id.is_empty() || id.contains('/') {
        return error(StatusCode::NOT_FOUND, "Not found");
    }
    if *method == Method::GET {
        match terminals.get(id).await {
            Some(meta) => json(
                StatusCode::OK,
                serde_json::to_value(meta).unwrap_or_default(),
            ),
            None => error(StatusCode::NOT_FOUND, "Unknown terminal session"),
        }
    } else if *method == Method::DELETE {
        let removed = terminals.delete(id).await;
        json(StatusCode::OK, serde_json::json!({ "success": removed }))
    } else {
        error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed")
    }
}

/// `/processes/{name}` and `/processes/{name}/{start|stop}` — the supervised
/// process control surface (lazy activation, restart, inspection).
async fn route_process(
    method: &Method,
    path: &str,
    query: &str,
    supervisor: &Arc<Supervisor>,
) -> Response<Full<Bytes>> {
    let Some(rest) = path.strip_prefix("/processes/") else {
        return error(StatusCode::NOT_FOUND, "Not found");
    };
    let (name, action) = match rest.split_once('/') {
        Some((n, a)) => (n, Some(a)),
        None => (rest, None),
    };
    if name.is_empty() {
        return error(StatusCode::NOT_FOUND, "Not found");
    }
    match (method, action) {
        (&Method::GET, None) => match supervisor.get(name).await {
            Some(state) => json(
                StatusCode::OK,
                serde_json::to_value(state).unwrap_or_default(),
            ),
            None => error(StatusCode::NOT_FOUND, "Unknown process"),
        },
        // Byte-windowed log read; `offset`/`limit` are optional query params.
        // Caps `limit` at the shared body ceiling so a huge log can't be
        // slurped whole in one response.
        (&Method::GET, Some("logs")) => {
            let offset = query_u64(query, "offset", 0);
            let limit = query_u64(query, "limit", MAX_REQUEST_BODY_BYTES as u64)
                .min(MAX_REQUEST_BODY_BYTES as u64) as usize;
            json(
                StatusCode::OK,
                serde_json::to_value(supervisor.read_logs(name, offset, limit).await)
                    .unwrap_or_default(),
            )
        }
        (&Method::POST, Some("start")) => match supervisor.ensure_started(name).await {
            Ok(()) => json(StatusCode::OK, serde_json::json!({ "success": true })),
            Err(e) => error(classify_start_error(&e), &e),
        },
        (&Method::POST, Some("stop")) => match supervisor.stop(name).await {
            Ok(()) => json(StatusCode::OK, serde_json::json!({ "success": true })),
            Err(e) => error(StatusCode::NOT_FOUND, &e),
        },
        _ => error(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed"),
    }
}

/// Map a supervisor start error to an HTTP status: missing config is a
/// transient 503, an unknown process is 404, a spawn/log failure is 500.
fn classify_start_error(e: &str) -> StatusCode {
    if e == "no config" {
        StatusCode::SERVICE_UNAVAILABLE
    } else if e.starts_with("unknown process") {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::INTERNAL_SERVER_ERROR
    }
}

async fn handle_put_config(
    req: Request<hyper::body::Incoming>,
    store: Arc<ConfigStore>,
) -> Response<Full<Bytes>> {
    let body = match read_body(req, MAX_CONFIG_BODY_BYTES).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };
    let config: AgentConfig = match serde_json::from_slice(&body) {
        Ok(c) => c,
        Err(e) => return error(StatusCode::BAD_REQUEST, &format!("Invalid config: {e}")),
    };
    match store.set(config).await {
        Ok(()) => json(StatusCode::OK, serde_json::json!({ "success": true })),
        Err(e) => error(StatusCode::UNPROCESSABLE_ENTITY, &e),
    }
}

async fn read_body(
    req: Request<hyper::body::Incoming>,
    max: usize,
) -> Result<Bytes, Response<Full<Bytes>>> {
    let mut body = req.into_body();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|_| error(StatusCode::BAD_REQUEST, "Failed to read body"))?;
        if let Ok(data) = frame.into_data() {
            if buf.len().saturating_add(data.len()) > max {
                return Err(error(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Request body too large",
                ));
            }
            buf.extend_from_slice(&data);
        }
    }
    Ok(Bytes::from(buf))
}

fn json(status: StatusCode, body: serde_json::Value) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(
            serde_json::to_vec(&body).unwrap_or_default(),
        )))
        .expect("static response builder")
}

fn error(status: StatusCode, message: &str) -> Response<Full<Bytes>> {
    json(status, serde_json::json!({ "error": message }))
}
