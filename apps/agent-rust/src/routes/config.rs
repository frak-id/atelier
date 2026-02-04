use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Request, Response, StatusCode};

use crate::config::{
    get_config, reload_config, set_config, SandboxConfig, OPENCODE_AUTH_PATH,
    OPENCODE_CONFIG_PATH, VSCODE_EXTENSIONS_PATH, VSCODE_SETTINGS_PATH,
};
use crate::response::{json_error, json_ok};

pub fn handle_config() -> Response<Full<Bytes>> {
    match get_config() {
        Some(cfg) => json_ok(serde_json::to_value(cfg).unwrap_or_default()),
        None => json_error(StatusCode::NOT_FOUND, "Config not found"),
    }
}

pub async fn handle_set_config(
    req: Request<hyper::body::Incoming>,
) -> Response<Full<Bytes>> {
    use http_body_util::BodyExt;

    let body = match req.collect().await.map(|b| b.to_bytes()) {
        Ok(b) => b,
        Err(_) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "Failed to read body",
            )
        }
    };

    let config: SandboxConfig = match serde_json::from_slice(&body) {
        Ok(c) => c,
        Err(e) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                &format!("Invalid JSON: {}", e),
            )
        }
    };

    match set_config(config) {
        Ok(()) => json_ok(serde_json::json!({ "success": true })),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

pub fn handle_reload_config() -> Response<Full<Bytes>> {
    match reload_config() {
        Ok(()) => json_ok(serde_json::json!({ "success": true })),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

pub async fn handle_editor_config() -> Response<Full<Bytes>> {
    let (vscode_settings, vscode_extensions, opencode_auth, opencode_config) = tokio::join!(
        tokio::fs::read_to_string(VSCODE_SETTINGS_PATH),
        tokio::fs::read_to_string(VSCODE_EXTENSIONS_PATH),
        tokio::fs::read_to_string(OPENCODE_AUTH_PATH),
        tokio::fs::read_to_string(OPENCODE_CONFIG_PATH),
    );

    let parse = |result: Result<String, _>, default: &str| -> serde_json::Value {
        result
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| serde_json::from_str(default).expect("static default"))
    };

    json_ok(serde_json::json!({
        "vscode": {
            "settings": parse(vscode_settings, "{}"),
            "extensions": parse(vscode_extensions, "[]"),
        },
        "opencode": {
            "auth": parse(opencode_auth, "{}"),
            "config": parse(opencode_config, "{}"),
        }
    }))
}
