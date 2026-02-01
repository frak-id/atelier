use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Response, StatusCode};
use std::sync::LazyLock;

use crate::config::{ServiceConfig, LOG_DIR, SANDBOX_CONFIG};
use crate::response::{json_error, json_ok};
use crate::routes::process_manager::{
    LogOpenMode, ProcessRegistry, StartParams, StopResult,
};

static RUNNING_SERVICES: LazyLock<ProcessRegistry> =
    LazyLock::new(ProcessRegistry::new);

fn find_service_config(name: &str) -> Option<&ServiceConfig> {
    SANDBOX_CONFIG
        .as_ref()
        .and_then(|c| c.services.get(name))
}

pub async fn start_autostart_services() {
    let Some(cfg) = SANDBOX_CONFIG.as_ref() else {
        return;
    };
    for (name, svc) in &cfg.services {
        if svc.auto_start && svc.command.is_some() {
            println!("Auto-starting service: {}", name);
            if let Err(e) = start_service_internal(name, svc).await
            {
                eprintln!("Failed to auto-start {}: {}", name, e);
            }
        }
    }
}

async fn start_service_internal(
    name: &str,
    cfg: &ServiceConfig,
) -> Result<
    crate::routes::process_manager::ManagedProcess,
    String,
> {
    let command = cfg
        .command
        .as_deref()
        .ok_or_else(|| format!("Service '{}' has no command", name))?;

    let user = cfg.user.as_deref().unwrap_or("root");

    RUNNING_SERVICES
        .start_process(StartParams {
            name,
            command,
            user,
            workdir: None,
            port: Some(cfg.port.unwrap_or(0)),
            env: cfg.env.as_ref(),
            log_prefix: &format!("{}.log", name),
            log_open_mode: LogOpenMode::Truncate,
        })
        .await
}

pub async fn handle_services_list() -> Response<Full<Bytes>> {
    let running = RUNNING_SERVICES.list_processes().await;
    let mut running_map: std::collections::HashMap<
        String,
        serde_json::Value,
    > = running
        .into_iter()
        .filter_map(|v| {
            v.get("name")
                .and_then(|n| n.as_str())
                .map(|n| (n.to_string(), v.clone()))
        })
        .collect();

    let mut list: Vec<serde_json::Value> = Vec::new();

    if let Some(cfg) = SANDBOX_CONFIG.as_ref() {
        for (name, svc_cfg) in &cfg.services {
            if let Some(svc) = running_map.remove(name.as_str()) {
                list.push(svc);
            } else {
                let port = svc_cfg.port.unwrap_or(0);
                list.push(serde_json::json!({
                    "name": name,
                    "status": "stopped",
                    "pid": 0,
                    "port": port,
                    "startedAt": "",
                    "exitCode": null,
                    "logFile": format!("{}/{}.log", LOG_DIR, name),
                    "running": false
                }));
            }
        }
    }

    json_ok(serde_json::json!({ "services": list }))
}

pub async fn handle_service_status(
    name: &str,
) -> Response<Full<Bytes>> {
    if let Some(val) = RUNNING_SERVICES.get_process(name).await {
        return json_ok(val);
    }

    if let Some(svc_cfg) = find_service_config(name) {
        let port = svc_cfg.port.unwrap_or(0);
        return json_ok(serde_json::json!({
            "name": name,
            "status": "stopped",
            "pid": 0,
            "port": port,
            "startedAt": "",
            "exitCode": null,
            "logFile": format!("{}/{}.log", LOG_DIR, name),
            "running": false
        }));
    }

    json_error(
        StatusCode::NOT_FOUND,
        &format!("Unknown service: {}", name),
    )
}

pub async fn handle_service_start(
    name: &str,
) -> Response<Full<Bytes>> {
    let cfg = match find_service_config(name) {
        Some(c) => c,
        None => {
            return json_error(
                StatusCode::NOT_FOUND,
                &format!("Unknown service: {}", name),
            )
        }
    };

    match start_service_internal(name, cfg).await {
        Ok(svc) => json_ok(serde_json::json!({
            "status": "running",
            "pid": svc.pid,
            "name": svc.name,
            "port": svc.port,
            "logFile": svc.log_file,
            "startedAt": svc.started_at
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

pub async fn handle_service_stop(
    name: &str,
) -> Response<Full<Bytes>> {
    match RUNNING_SERVICES.stop_process(name, 500).await {
        StopResult::NotFound => json_ok(serde_json::json!({
            "status": "stopped",
            "name": name,
            "message": "Service not found or already stopped"
        })),
        StopResult::AlreadyStopped { status, exit_code } => {
            json_ok(serde_json::json!({
                "status": status,
                "name": name,
                "exitCode": exit_code,
                "message": "Service already stopped"
            }))
        }
        StopResult::Stopped { pid } => {
            json_ok(serde_json::json!({
                "status": "stopped",
                "name": name,
                "pid": pid,
                "message": "Service stopped"
            }))
        }
    }
}

pub async fn handle_service_restart(
    name: &str,
) -> Response<Full<Bytes>> {
    RUNNING_SERVICES.stop_process(name, 500).await;
    handle_service_start(name).await
}

pub async fn handle_service_logs(
    name: &str,
    query: &str,
) -> Response<Full<Bytes>> {
    if find_service_config(name).is_none() {
        return json_error(
            StatusCode::NOT_FOUND,
            &format!("Unknown service: {}", name),
        );
    }

    let log_path = format!("{}/{}.log", LOG_DIR, name);
    crate::routes::process_manager::read_logs(
        name, &log_path, query,
    )
    .await
}
