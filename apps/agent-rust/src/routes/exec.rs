use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::{Request, Response};
use serde::Deserialize;
use std::time::Duration;
use tokio::process::Command;

use crate::config::{DEFAULT_EXEC_TIMEOUT_MS, MAX_EXEC_BUFFER};
use crate::response::json_ok;

#[derive(Deserialize)]
struct ExecBody {
    command: String,
    timeout: Option<u64>,
    user: Option<String>,
    workdir: Option<String>,
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

async fn run_command(
    command: &str,
    timeout_ms: Option<u64>,
    user: Option<&str>,
    workdir: Option<&str>,
) -> serde_json::Value {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_EXEC_TIMEOUT_MS));

    let mut cmd = Command::new("/bin/bash");
    cmd.args(["-l", "-c", command]);

    if user == Some("dev") {
        cmd.uid(1000).gid(1000);
        cmd.env("HOME", "/home/dev");
        cmd.env("USER", "dev");
    }

    if let Some(dir) = workdir {
        cmd.current_dir(dir);
    }

    let result = tokio::time::timeout(timeout, cmd.output()).await;

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

    json_ok(run_command(
        &parsed.command,
        parsed.timeout,
        parsed.user.as_deref(),
        parsed.workdir.as_deref(),
    ).await)
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
            let mut result = run_command(
                &cmd.command,
                cmd.timeout,
                cmd.user.as_deref(),
                cmd.workdir.as_deref(),
            ).await;
            result.as_object_mut().expect("json object").insert("id".into(), serde_json::Value::String(cmd.id));
            result
        });
    }

    let mut results = Vec::with_capacity(set.len());
    while let Some(Ok(result)) = set.join_next().await {
        results.push(result);
    }
    json_ok(serde_json::json!({ "results": results }))
}
