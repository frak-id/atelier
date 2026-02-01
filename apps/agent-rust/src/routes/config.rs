use http_body_util::Full;
use hyper::body::Bytes;
use hyper::Response;

use crate::config::{
    OPENCODE_AUTH_PATH, OPENCODE_CONFIG_PATH, SANDBOX_CONFIG, VSCODE_EXTENSIONS_PATH,
    VSCODE_SETTINGS_PATH,
};

fn json_ok(body: serde_json::Value) -> Response<Full<Bytes>> {
    Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap()
}

pub fn handle_config() -> Response<Full<Bytes>> {
    match SANDBOX_CONFIG.as_ref() {
        Some(cfg) => json_ok(serde_json::to_value(cfg).unwrap()),
        None => json_ok(serde_json::json!({"error": "Config not found"})),
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
            .unwrap_or_else(|| serde_json::from_str(default).unwrap())
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
