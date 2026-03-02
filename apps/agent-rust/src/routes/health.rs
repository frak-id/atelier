use http_body_util::Full;
use hyper::body::Bytes;
use hyper::Response;
use std::sync::LazyLock;
use std::time::Instant;

use crate::response::json_ok;

static START_TIME: LazyLock<Instant> = LazyLock::new(Instant::now);

pub async fn handle_health() -> Response<Full<Bytes>> {
    let _ = *START_TIME;
    let uptime = START_TIME.elapsed().as_secs_f64();

    json_ok(serde_json::json!({
        "status": "healthy",
        "uptime": uptime
    }))
}
