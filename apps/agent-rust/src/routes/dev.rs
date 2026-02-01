use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::{Request, Response, StatusCode};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::LazyLock;

use crate::config::{LOG_DIR, WORKSPACE_DIR};
use crate::response::{json_error, json_ok};
use crate::routes::process_manager::{
    LogOpenMode, ProcessRegistry, StartParams, StopResult,
};

static RUNNING_DEV_COMMANDS: LazyLock<ProcessRegistry> =
    LazyLock::new(ProcessRegistry::new);

pub async fn handle_get_dev() -> Response<Full<Bytes>> {
    let list = RUNNING_DEV_COMMANDS.list_processes().await;
    json_ok(serde_json::json!({ "commands": list }))
}

pub async fn handle_dev_start(
    name: &str,
    req: Request<hyper::body::Incoming>,
) -> Response<Full<Bytes>> {
    let body = match req.collect().await.map(|b| b.to_bytes()) {
        Ok(b) => b,
        Err(_) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "Failed to read body",
            )
        }
    };

    #[derive(Deserialize)]
    struct StartBody {
        command: String,
        workdir: Option<String>,
        env: Option<HashMap<String, String>>,
        port: Option<u16>,
    }

    let parsed: StartBody = match serde_json::from_slice(&body) {
        Ok(p) => p,
        Err(_) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "Invalid JSON",
            )
        }
    };

    let workdir =
        parsed.workdir.unwrap_or_else(|| WORKSPACE_DIR.to_string());

    match RUNNING_DEV_COMMANDS
        .start_process(StartParams {
            name,
            command: &parsed.command,
            user: "root",
            workdir: Some(&workdir),
            port: parsed.port,
            env: parsed.env.as_ref(),
            log_prefix: &format!("dev-{}.log", name),
            log_open_mode: LogOpenMode::Append,
        })
        .await
    {
        Ok(proc) => json_ok(serde_json::json!({
            "status": "running",
            "pid": proc.pid,
            "name": name,
            "port": proc.port,
            "logFile": proc.log_file,
            "startedAt": proc.started_at
        })),
        Err(e) => {
            let status = if e.contains("already running") {
                StatusCode::CONFLICT
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, &e)
        }
    }
}

pub async fn handle_dev_stop(
    name: &str,
) -> Response<Full<Bytes>> {
    match RUNNING_DEV_COMMANDS.stop_process(name, 100).await {
        StopResult::NotFound => json_ok(serde_json::json!({
            "status": "stopped",
            "name": name,
            "message": "Command not found or already stopped"
        })),
        StopResult::AlreadyStopped { status, exit_code } => {
            json_ok(serde_json::json!({
                "status": status,
                "name": name,
                "exitCode": exit_code,
                "message": "Command already stopped"
            }))
        }
        StopResult::Stopped { pid } => {
            json_ok(serde_json::json!({
                "status": "stopped",
                "name": name,
                "pid": pid,
                "message": "Command stopped"
            }))
        }
    }
}

pub async fn handle_dev_logs(
    name: &str,
    query: &str,
) -> Response<Full<Bytes>> {
    let log_path = format!("{}/dev-{}.log", LOG_DIR, name);
    crate::routes::process_manager::read_logs(
        name, &log_path, query,
    )
    .await
}
