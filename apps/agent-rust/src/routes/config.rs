use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Request, Response, StatusCode};

use crate::body::{read_body_limited, ReadBodyError};
use crate::config::{get_config, set_config, SandboxConfig};
use crate::limits::MAX_REQUEST_BODY_BYTES;
use crate::response::{json_error, json_ok};
use crate::terminal;

pub fn handle_config() -> Response<Full<Bytes>> {
    match get_config() {
        Some(cfg) => json_ok(serde_json::to_value(cfg).unwrap_or_default()),
        None => json_error(StatusCode::NOT_FOUND, "Config not found"),
    }
}

pub async fn handle_set_config(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let body = match read_body_limited(req, MAX_REQUEST_BODY_BYTES).await {
        Ok(b) => b,
        Err(ReadBodyError::TooLarge) => {
            return json_ok(serde_json::json!({
                "success": false,
                "error": "Request body too large"
            }))
        }
        Err(ReadBodyError::ReadFailed) => {
            return json_error(StatusCode::BAD_REQUEST, "Failed to read body")
        }
    };

    let config: SandboxConfig = match serde_json::from_slice(&body) {
        Ok(c) => c,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &format!("Invalid JSON: {}", e)),
    };

    match set_config(config) {
        Ok(()) => {
            terminal::ensure_terminal_from_config().await;
            json_ok(serde_json::json!({ "success": true }))
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}
