use http_body_util::Full;
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::{Request, Response};
use serde::Deserialize;

use crate::body::{read_body_limited, ReadBodyError};
use crate::command::run_shell_command_limited;
use crate::config::DEFAULT_EXEC_TIMEOUT_MS;
use crate::limits::{EXEC_SEMAPHORE, MAX_COMMAND_OUTPUT_BYTES, MAX_REQUEST_BODY_BYTES};
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

pub async fn handle_exec(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let _permit = EXEC_SEMAPHORE.acquire().await.unwrap();

    let body = match read_body_limited(req, MAX_REQUEST_BODY_BYTES).await {
        Ok(b) => b,
        Err(ReadBodyError::TooLarge) => {
            return json_ok(serde_json::json!({
                "exitCode": 1,
                "stdout": "",
                "stderr": "Request body too large"
            }))
        }
        Err(ReadBodyError::ReadFailed) => {
            return json_ok(serde_json::json!({
                "exitCode": 1,
                "stdout": "",
                "stderr": "Failed to read body"
            }))
        }
    };
    let parsed: ExecBody = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(_) => {
            return json_ok(
                serde_json::json!({"exitCode": 1, "stdout": "", "stderr": "Invalid JSON"}),
            )
        }
    };

    let timeout_ms = parsed.timeout.unwrap_or(DEFAULT_EXEC_TIMEOUT_MS);
    json_ok(
        run_shell_command_limited(
            &parsed.command,
            timeout_ms,
            parsed.user.as_deref(),
            parsed.workdir.as_deref(),
            MAX_COMMAND_OUTPUT_BYTES,
        )
        .await,
    )
}

pub async fn handle_exec_batch(req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let body = match read_body_limited(req, MAX_REQUEST_BODY_BYTES).await {
        Ok(b) => b,
        Err(ReadBodyError::TooLarge) => {
            return json_ok(serde_json::json!({
                "results": [],
                "error": "Request body too large"
            }))
        }
        Err(ReadBodyError::ReadFailed) => return json_ok(serde_json::json!({"results": []})),
    };
    let parsed: BatchBody = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(_) => return json_ok(serde_json::json!({"results": []})),
    };

    let mut set = tokio::task::JoinSet::new();
    for cmd in parsed.commands {
        set.spawn(async move {
            let _permit = EXEC_SEMAPHORE.acquire().await.unwrap();
            let timeout_ms = cmd.timeout.unwrap_or(DEFAULT_EXEC_TIMEOUT_MS);
            let mut result = run_shell_command_limited(
                &cmd.command,
                timeout_ms,
                cmd.user.as_deref(),
                cmd.workdir.as_deref(),
                MAX_COMMAND_OUTPUT_BYTES,
            )
            .await;
            result
                .as_object_mut()
                .expect("json object")
                .insert("id".into(), serde_json::Value::String(cmd.id));
            result
        });
    }

    let mut results = Vec::with_capacity(set.len());
    while let Some(Ok(result)) = set.join_next().await {
        results.push(result);
    }
    json_ok(serde_json::json!({ "results": results }))
}
