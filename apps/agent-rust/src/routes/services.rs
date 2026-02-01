use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Response, StatusCode};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::LazyLock;
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::config::{ServiceConfig, LOG_DIR, SANDBOX_CONFIG};
use crate::response::{json_error, json_ok};
use crate::routes::dev::{is_process_running, pump_stream, signal_process, ProcessStatus};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManagedService {
    name: String,
    status: ProcessStatus,
    pid: u32,
    port: u16,
    started_at: String,
    exit_code: Option<i32>,
    log_file: String,
    running: bool,
}

static RUNNING_SERVICES: LazyLock<Mutex<HashMap<String, ManagedService>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

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
            if let Err(e) = start_service_internal(name, svc).await {
                eprintln!("Failed to auto-start {}: {}", name, e);
            }
        }
    }
}

async fn start_service_internal(
    name: &str,
    cfg: &ServiceConfig,
) -> Result<ManagedService, String> {
    let command = cfg
        .command
        .as_deref()
        .ok_or_else(|| format!("Service '{}' has no command", name))?;

    let port = cfg.port.unwrap_or(0);

    {
        let services = RUNNING_SERVICES.lock().await;
        if let Some(existing) = services.get(name) {
            if existing.status == ProcessStatus::Running && is_process_running(existing.pid) {
                return Err(format!(
                    "Service '{}' is already running with PID {}",
                    name, existing.pid
                ));
            }
        }
    }

    let log_file = format!("{}/{}.log", LOG_DIR, name);

    let log_handle = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_file)
        .await
        .map_err(|e| e.to_string())?;

    let user = cfg.user.as_deref().unwrap_or("root");
    let wrapped_cmd = if user == "dev" {
        format!("su - dev -c \"{}\"", command.replace('"', "\\\""))
    } else {
        command.to_string()
    };

    let mut cmd = Command::new("/bin/sh");
    cmd.args(["-c", &wrapped_cmd])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if let Some(env_map) = &cfg.env {
        cmd.envs(env_map);
    }

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    let pid = child.id().unwrap_or(0);
    let started_at = crate::utc_rfc3339();

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let (_log_rd, log_wr) = tokio::io::split(log_handle);
    let log_wr = std::sync::Arc::new(tokio::sync::Mutex::new(log_wr));

    if let Some(stdout) = stdout {
        let wr = log_wr.clone();
        tokio::spawn(async move {
            pump_stream(stdout, wr).await;
        });
    }
    if let Some(stderr) = stderr {
        let wr = log_wr.clone();
        tokio::spawn(async move {
            pump_stream(stderr, wr).await;
        });
    }

    let name_owned = name.to_string();
    let child_pid = pid;
    let wait_name = name_owned.clone();

    tokio::spawn(async move {
        let status = child.wait().await;
        let mut svcs = RUNNING_SERVICES.lock().await;
        if let Some(svc) = svcs.get_mut(&wait_name) {
            if svc.pid == child_pid {
                match status {
                    Ok(s) => {
                        let code = s.code().unwrap_or(-1);
                        svc.exit_code = Some(code);
                        svc.status = if code == 0 {
                            ProcessStatus::Stopped
                        } else {
                            ProcessStatus::Error
                        };
                        svc.running = false;
                    }
                    Err(_) => {
                        svc.status = ProcessStatus::Error;
                        svc.running = false;
                    }
                }
            }
        }
    });

    let svc = ManagedService {
        name: name_owned.clone(),
        status: ProcessStatus::Running,
        pid,
        port,
        started_at: started_at.clone(),
        exit_code: None,
        log_file: log_file.clone(),
        running: true,
    };

    RUNNING_SERVICES
        .lock()
        .await
        .insert(name_owned.clone(), svc);

    let result = ManagedService {
        name: name_owned,
        status: ProcessStatus::Running,
        pid,
        port,
        started_at,
        exit_code: None,
        log_file,
        running: true,
    };

    Ok(result)
}

pub async fn handle_services_list() -> Response<Full<Bytes>> {
    let mut services = RUNNING_SERVICES.lock().await;

    for svc in services.values_mut() {
        if svc.status == ProcessStatus::Running && !is_process_running(svc.pid) {
            svc.status = ProcessStatus::Error;
            svc.running = false;
        }
    }

    let mut list: Vec<serde_json::Value> = Vec::new();

    if let Some(cfg) = SANDBOX_CONFIG.as_ref() {
        for (name, svc_cfg) in &cfg.services {
            if let Some(svc) = services.get(name.as_str()) {
                list.push(serde_json::to_value(svc).unwrap_or_default());
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

pub async fn handle_service_status(name: &str) -> Response<Full<Bytes>> {
    let mut services = RUNNING_SERVICES.lock().await;

    if let Some(svc) = services.get_mut(name) {
        if svc.status == ProcessStatus::Running && !is_process_running(svc.pid) {
            svc.status = ProcessStatus::Error;
            svc.running = false;
        }
        return json_ok(serde_json::to_value(&*svc).unwrap_or_default());
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

pub async fn handle_service_start(name: &str) -> Response<Full<Bytes>> {
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

pub async fn handle_service_stop(name: &str) -> Response<Full<Bytes>> {
    let mut services = RUNNING_SERVICES.lock().await;

    let svc = match services.get_mut(name) {
        Some(s) => s,
        None => {
            return json_ok(serde_json::json!({
                "status": "stopped",
                "name": name,
                "message": "Service not found or already stopped"
            }));
        }
    };

    if svc.status != ProcessStatus::Running || !is_process_running(svc.pid) {
        svc.status = if svc.exit_code == Some(0) {
            ProcessStatus::Stopped
        } else {
            ProcessStatus::Error
        };
        svc.running = false;
        return json_ok(serde_json::json!({
            "status": svc.status,
            "name": name,
            "exitCode": svc.exit_code,
            "message": "Service already stopped"
        }));
    }

    let pid = svc.pid;
    signal_process(pid, libc::SIGTERM);

    drop(services);
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;

    let mut services = RUNNING_SERVICES.lock().await;
    if is_process_running(pid) {
        signal_process(pid, libc::SIGKILL);
    }

    if let Some(svc) = services.get_mut(name) {
        svc.status = ProcessStatus::Stopped;
        svc.running = false;
        if svc.exit_code.is_none() {
            svc.exit_code = Some(-1);
        }
    }

    json_ok(serde_json::json!({
        "status": "stopped",
        "name": name,
        "pid": pid,
        "message": "Service stopped"
    }))
}

pub async fn handle_service_restart(name: &str) -> Response<Full<Bytes>> {
    {
        let mut services = RUNNING_SERVICES.lock().await;
        if let Some(svc) = services.get_mut(name) {
            if svc.status == ProcessStatus::Running && is_process_running(svc.pid) {
                let pid = svc.pid;
                signal_process(pid, libc::SIGTERM);
                drop(services);
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                let mut services = RUNNING_SERVICES.lock().await;
                if is_process_running(pid) {
                    signal_process(pid, libc::SIGKILL);
                }
                if let Some(svc) = services.get_mut(name) {
                    svc.status = ProcessStatus::Stopped;
                    svc.running = false;
                    if svc.exit_code.is_none() {
                        svc.exit_code = Some(-1);
                    }
                }
            }
        }
    }

    handle_service_start(name).await
}

pub async fn handle_service_logs(name: &str, query: &str) -> Response<Full<Bytes>> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    if find_service_config(name).is_none() {
        return json_error(
            StatusCode::NOT_FOUND,
            &format!("Unknown service: {}", name),
        );
    }

    let mut offset: u64 = 0;
    let mut limit: usize = 10000;

    for param in query.split('&') {
        let mut kv = param.splitn(2, '=');
        match (kv.next(), kv.next()) {
            (Some("offset"), Some(v)) => offset = v.parse().unwrap_or(0),
            (Some("limit"), Some(v)) => limit = v.parse().unwrap_or(10000),
            _ => {}
        }
    }

    let log_path = format!("{}/{}.log", LOG_DIR, name);

    let mut file = match tokio::fs::File::open(&log_path).await {
        Ok(f) => f,
        Err(_) => {
            return json_ok(serde_json::json!({
                "name": name,
                "content": "",
                "nextOffset": 0
            }));
        }
    };

    if offset > 0 {
        if file
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .is_err()
        {
            return json_ok(serde_json::json!({
                "name": name,
                "content": "",
                "nextOffset": offset
            }));
        }
    }

    let mut buf = vec![0u8; limit];
    let n = match file.read(&mut buf).await {
        Ok(n) => n,
        Err(_) => 0,
    };
    buf.truncate(n);

    let content = String::from_utf8_lossy(&buf);
    let next_offset = offset + n as u64;

    json_ok(serde_json::json!({
        "name": name,
        "content": content,
        "nextOffset": next_offset
    }))
}
