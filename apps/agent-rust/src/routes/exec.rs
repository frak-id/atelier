use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::{Request, Response};
use serde::Deserialize;
use std::time::Duration;
use tokio::process::Command;

use crate::config::{DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_BUFFER};

#[derive(Deserialize)]
struct ExecBody {
    command: String,
    timeout: Option<u64>,
}

#[derive(Deserialize)]
struct BatchCommand {
    id: String,
    command: String,
    timeout: Option<u64>,
}

#[derive(Deserialize)]
struct BatchBody {
    commands: Vec<BatchCommand>,
}

async fn run_command(command: &str, timeout_ms: Option<u64>) -> serde_json::Value {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_EXEC_TIMEOUT_MS));

    let result = tokio::time::timeout(timeout, async {
        Command::new("sh")
            .args(["-c", command])
            .output()
            .await
    })
    .await;

    match result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout[..output.stdout.len().min(MAX_EXEC_BUFFER)]);
            let stderr = String::from_utf8_lossy(&output.stderr[..output.stderr.len().min(MAX_EXEC_BUFFER)]);
            serde_json::json!({
                "exitCode": output.status.code().unwrap_or(1),
                "stdout": stdout,
                "stderr": stderr
            })
        }
        Ok(Err(e)) => serde_json::json!({
            "exitCode": 1,
            "stdout": "",
            "stderr": e.to_string()
        }),
        Err(_) => serde_json::json!({
            "exitCode": 1,
            "stdout": "",
            "stderr": "Command timed out"
        }),
    }
}

fn json_ok(body: serde_json::Value) -> Response<Full<Bytes>> {
    Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap()
}

async fn read_body(req: Request<hyper::body::Incoming>) -> Result<Bytes, hyper::Error> {
    Ok(req.collect().await?.to_bytes())
}

pub async fn handle_exec(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(_) => return json_ok(serde_json::json!({"exitCode": 1, "stdout": "", "stderr": "Failed to read body"})),
    };
    let parsed: ExecBody = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(_) => return json_ok(serde_json::json!({"exitCode": 1, "stdout": "", "stderr": "Invalid JSON"})),
    };

    json_ok(run_command(&parsed.command, parsed.timeout).await)
}

pub async fn handle_exec_batch(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let body = match read_body(req).await {
        Ok(b) => b,
        Err(_) => return json_ok(serde_json::json!({"results": []})),
    };
    let parsed: BatchBody = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(_) => return json_ok(serde_json::json!({"results": []})),
    };

    let mut set = tokio::task::JoinSet::new();
    for cmd in parsed.commands {
        set.spawn(async move {
            let mut result = run_command(&cmd.command, cmd.timeout).await;
            result.as_object_mut().unwrap().insert("id".into(), serde_json::Value::String(cmd.id));
            result
        });
    }

    let mut results = Vec::with_capacity(set.len());
    while let Some(Ok(result)) = set.join_next().await {
        results.push(result);
    }
    json_ok(serde_json::json!({ "results": results }))
}
