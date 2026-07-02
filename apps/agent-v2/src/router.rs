//! HTTP control plane on :9998. 1a surface: health + config push/read.
//! Supervisor/bridge/exec/files routes land with their modules (1b–1d).

use std::sync::Arc;
use std::time::Instant;

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::{Method, Request, Response, StatusCode};

use crate::config::AgentConfig;
use crate::store::ConfigStore;
use crate::supervisor::Supervisor;

/// Config bodies are runtime-authored (spec-sized), not user uploads.
const MAX_CONFIG_BODY_BYTES: usize = 4 * 1024 * 1024;

pub async fn route(
    req: Request<hyper::body::Incoming>,
    store: Arc<ConfigStore>,
    supervisor: Arc<Supervisor>,
) -> Response<Full<Bytes>> {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    let start = *START.get_or_init(Instant::now);

    let method = req.method().clone();
    let path = req.uri().path().to_string();

    match (&method, path.as_str()) {
        // `healthy` reflects the spec's `primary` process readiness — the
        // generic replacement for v1's hardcoded opencode boot gate.
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
        _ => route_process(&method, &path, &supervisor).await,
    }
}

/// `/processes/{name}` and `/processes/{name}/{start|stop}` — the supervised
/// process control surface (lazy activation, restart, inspection).
async fn route_process(
    method: &Method,
    path: &str,
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
