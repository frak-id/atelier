use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Response, StatusCode};

pub fn json(status: StatusCode, body: impl Into<Bytes>) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Full::new(body.into()))
        .expect("static response builder")
}

pub fn json_ok(body: serde_json::Value) -> Response<Full<Bytes>> {
    json(
        StatusCode::OK,
        Bytes::from(serde_json::to_vec(&body).unwrap_or_default()),
    )
}

pub fn json_error(status: StatusCode, message: &str) -> Response<Full<Bytes>> {
    json(
        status,
        Bytes::from(serde_json::to_vec(&serde_json::json!({"error": message})).unwrap_or_default()),
    )
}
