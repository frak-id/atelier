use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::{Request, Response, StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;

use crate::config::{LOG_DIR, WORKSPACE_DIR};
use crate::response::{json_error, json_ok};
use crate::routes::process_manager::{
    LogOpenMode, ManagedProcess, ProcessRegistry, StartParams,
    StopResult,
};

static RUNNING_DEV_COMMANDS: LazyLock<ProcessRegistry> =
    LazyLock::new(ProcessRegistry::new);

#[derive(Serialize)]
struct DevListResponse {
    commands: Vec<ManagedProcess>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DevStartResponse {
    status: String,
    pid: u32,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    log_file: String,
    started_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DevStopResponse {
    status: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    message: String,
}

pub async fn handle_get_dev() -> Response<Full<Bytes>> {
    let commands = RUNNING_DEV_COMMANDS.list_processes().await;
    json_ok(
        serde_json::to_value(DevListResponse { commands }).unwrap(),
    )
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
        Ok(proc) => json_ok(
            serde_json::to_value(DevStartResponse {
                status: "running".to_string(),
                pid: proc.pid,
                name: proc.name,
                port: proc.port,
                log_file: proc.log_file,
                started_at: proc.started_at,
            })
            .unwrap(),
        ),
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
    let resp = match RUNNING_DEV_COMMANDS.stop_process(name, 100).await
    {
        StopResult::NotFound => DevStopResponse {
            status: "stopped".to_string(),
            name: name.to_string(),
            pid: None,
            exit_code: None,
            message: "Command not found or already stopped".to_string(),
        },
        StopResult::AlreadyStopped { status, exit_code } => {
            DevStopResponse {
                status: format!("{:?}", status).to_lowercase(),
                name: name.to_string(),
                pid: None,
                exit_code,
                message: "Command already stopped".to_string(),
            }
        }
        StopResult::Stopped { pid } => DevStopResponse {
            status: "stopped".to_string(),
            name: name.to_string(),
            pid: Some(pid),
            exit_code: None,
            message: "Command stopped".to_string(),
        },
    };
    json_ok(serde_json::to_value(resp).unwrap())
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
