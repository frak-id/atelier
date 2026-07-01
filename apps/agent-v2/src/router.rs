//! HTTP control plane on :9998. 1a surface: health + config push/read.
//! Supervisor/bridge/exec/files routes land with their modules (1b–1d).

use std::sync::Arc;
use std::time::Instant;

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::{Method, Request, Response, StatusCode};

use crate::config::AgentConfig;
use crate::store::ConfigStore;

/// Config bodies are runtime-authored (spec-sized), not user uploads.
const MAX_CONFIG_BODY_BYTES: usize = 4 * 1024 * 1024;

pub async fn route(
    req: Request<hyper::body::Incoming>,
    store: Arc<ConfigStore>,
) -> Response<Full<Bytes>> {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    let start = *START.get_or_init(Instant::now);

    match (req.method().clone(), req.uri().path()) {
        (Method::GET, "/health") => json(
            StatusCode::OK,
            serde_json::json!({
                "status": "healthy",
                "uptime": start.elapsed().as_secs_f64(),
                "configured": store.get().is_some(),
            }),
        ),
        (Method::GET, "/config") => match store.get() {
            Some(cfg) => json(
                StatusCode::OK,
                serde_json::to_value(cfg.as_ref()).unwrap_or_default(),
            ),
            None => error(StatusCode::NOT_FOUND, "No config pushed yet"),
        },
        (Method::PUT, "/config") => handle_put_config(req, store).await,
        _ => error(StatusCode::NOT_FOUND, "Not found"),
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
