use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Response, StatusCode};
use serde::Serialize;
use std::sync::LazyLock;

use crate::config::{get_config, ServiceConfig, LOG_DIR};
use crate::response::{json_error, json_ok};
use crate::routes::process_manager::{
    ManagedProcess, ProcessRegistry, StartParams, StopResult,
};

static RUNNING_SERVICES: LazyLock<ProcessRegistry> =
    LazyLock::new(ProcessRegistry::new);

#[derive(Serialize)]
struct ServiceListResponse {
    services: Vec<ManagedProcess>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceStartResponse {
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
struct ServiceStopResponse {
    status: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i32>,
    message: String,
}

fn find_service_config(name: &str) -> Option<ServiceConfig> {
    get_config().and_then(|c| c.services.get(name).cloned())
}

fn stopped_service(name: &str, cfg: &ServiceConfig) -> ManagedProcess {
    ManagedProcess {
        name: name.to_string(),
        status: crate::routes::process_manager::ProcessStatus::Stopped,
        pid: 0,
        port: cfg.port,
        started_at: String::new(),
        exit_code: None,
        log_file: format!("{}/{}.log", LOG_DIR, name),
        running: false,
    }
}

async fn start_service_internal(
    name: &str,
    cfg: &ServiceConfig,
) -> Result<ManagedProcess, String> {
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
        })
        .await
}

pub async fn handle_services_list() -> Response<Full<Bytes>> {
    let running = RUNNING_SERVICES.list_processes().await;
    let mut running_map: std::collections::HashMap<String, ManagedProcess> =
        running
            .into_iter()
            .map(|p| (p.name.clone(), p))
            .collect();

    let mut services: Vec<ManagedProcess> = Vec::new();

    if let Some(cfg) = get_config() {
        for (name, svc_cfg) in &cfg.services {
            if let Some(svc) = running_map.remove(name.as_str()) {
                services.push(svc);
            } else {
                services.push(stopped_service(name, svc_cfg));
            }
        }
    }

    json_ok(
        serde_json::to_value(ServiceListResponse { services })
            .unwrap(),
    )
}

pub async fn handle_service_status(
    name: &str,
) -> Response<Full<Bytes>> {
    if let Some(proc) = RUNNING_SERVICES.get_process(name).await {
        return json_ok(serde_json::to_value(proc).unwrap());
    }

    if let Some(svc_cfg) = find_service_config(name) {
        return json_ok(
            serde_json::to_value(stopped_service(name, &svc_cfg))
                .unwrap(),
        );
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

    match start_service_internal(name, &cfg).await {
        Ok(svc) => json_ok(
            serde_json::to_value(ServiceStartResponse {
                status: "running".to_string(),
                pid: svc.pid,
                name: svc.name,
                port: svc.port,
                log_file: svc.log_file,
                started_at: svc.started_at,
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

pub async fn handle_service_stop(
    name: &str,
) -> Response<Full<Bytes>> {
    let resp = match RUNNING_SERVICES.stop_process(name, 500).await {
        StopResult::NotFound => ServiceStopResponse {
            status: "stopped".to_string(),
            name: name.to_string(),
            pid: None,
            exit_code: None,
            message: "Service not found or already stopped".to_string(),
        },
        StopResult::AlreadyStopped { status, exit_code } => {
            ServiceStopResponse {
                status: format!("{:?}", status).to_lowercase(),
                name: name.to_string(),
                pid: None,
                exit_code,
                message: "Service already stopped".to_string(),
            }
        }
        StopResult::Stopped { pid } => ServiceStopResponse {
            status: "stopped".to_string(),
            name: name.to_string(),
            pid: Some(pid),
            exit_code: None,
            message: "Service stopped".to_string(),
        },
    };
    json_ok(serde_json::to_value(resp).unwrap())
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
