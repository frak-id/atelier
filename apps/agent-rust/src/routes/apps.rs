use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::{Request, Response};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

use std::sync::LazyLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPort {
    pub port: u16,
    pub name: String,
    pub registered_at: String,
}

static REGISTERED_APPS: LazyLock<Mutex<Vec<AppPort>>> = LazyLock::new(|| Mutex::new(Vec::new()));

fn json_ok(body: serde_json::Value) -> Response<Full<Bytes>> {
    Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap()
}

pub fn handle_get_apps() -> Response<Full<Bytes>> {
    let apps = REGISTERED_APPS.lock().unwrap();
    json_ok(serde_json::to_value(&*apps).unwrap())
}

pub async fn handle_post_apps(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let body = req.collect().await.map(|b| b.to_bytes()).unwrap_or_default();

    #[derive(Deserialize)]
    struct PostBody {
        port: u16,
        name: String,
    }

    let parsed: PostBody = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(_) => return json_ok(serde_json::json!({"error": "Invalid JSON"})),
    };

    let mut apps = REGISTERED_APPS.lock().unwrap();

    if let Some(existing) = apps.iter_mut().find(|a| a.port == parsed.port) {
        existing.name = parsed.name;
        return json_ok(serde_json::to_value(&*existing).unwrap());
    }

    let app = AppPort {
        port: parsed.port,
        name: parsed.name,
        registered_at: crate::utc_rfc3339(),
    };
    apps.push(app.clone());
    json_ok(serde_json::to_value(&app).unwrap())
}

pub fn handle_delete_app(port: u16) -> Response<Full<Bytes>> {
    let mut apps = REGISTERED_APPS.lock().unwrap();
    let len_before = apps.len();
    apps.retain(|a| a.port != port);
    json_ok(serde_json::json!({ "success": apps.len() < len_before }))
}
