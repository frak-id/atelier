use http_body_util::Full;
use hyper::body::Bytes;
use hyper::{Response, StatusCode};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::LazyLock;
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::config::{LOG_DIR, SANDBOX_CONFIG, WORKSPACE_DIR};
use crate::response::{json_error, json_ok};
use crate::routes::dev::{is_process_running, pump_stream, signal_process, ProcessStatus};
use crate::routes::health::check_port_listening;

struct ServiceDef {
    name: &'static str,
    command_template: fn() -> String,
    user: &'static str,
    port: fn() -> u16,
}

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

fn get_workspace_dir() -> String {
    SANDBOX_CONFIG
        .as_ref()
        .and_then(|c| c.repos.first())
        .map(|r| format!("/home/dev{}", r.clone_path))
        .unwrap_or_else(|| WORKSPACE_DIR.to_string())
}

fn get_dashboard_domain() -> String {
    SANDBOX_CONFIG
        .as_ref()
        .map(|c| c.network.dashboard_domain.clone())
        .unwrap_or_default()
}

fn code_server_port() -> u16 {
    SANDBOX_CONFIG
        .as_ref()
        .map(|c| c.services.vscode.port)
        .unwrap_or(8080)
}

fn opencode_port() -> u16 {
    SANDBOX_CONFIG
        .as_ref()
        .map(|c| c.services.opencode.port)
        .unwrap_or(3000)
}

fn ttyd_port() -> u16 {
    SANDBOX_CONFIG
        .as_ref()
        .map(|c| c.services.terminal.port)
        .unwrap_or(7681)
}

fn code_server_command() -> String {
    let port = code_server_port();
    let workdir = get_workspace_dir();
    format!("/opt/shared/bin/code-server --bind-addr 0.0.0.0:{port} --auth none --disable-telemetry {workdir}")
}

fn opencode_command() -> String {
    let port = opencode_port();
    let workdir = get_workspace_dir();
    let domain = get_dashboard_domain();
    format!("cd {workdir} && /opt/shared/bin/opencode serve --hostname 0.0.0.0 --port {port} --cors https://{domain}")
}

fn ttyd_command() -> String {
    let port = ttyd_port();
    format!("ttyd -p {port} -W -t fontSize=14 -t fontFamily=monospace su - dev")
}

static SERVICE_DEFS: &[ServiceDef] = &[
    ServiceDef {
        name: "code-server",
        command_template: code_server_command,
        user: "dev",
        port: code_server_port,
    },
    ServiceDef {
        name: "opencode",
        command_template: opencode_command,
        user: "dev",
        port: opencode_port,
    },
    ServiceDef {
        name: "ttyd",
        command_template: ttyd_command,
        user: "root",
        port: ttyd_port,
    },
];

fn find_service_def(name: &str) -> Option<&'static ServiceDef> {
    SERVICE_DEFS.iter().find(|d| d.name == name)
}

pub async fn discover_running_services() {
    for def in SERVICE_DEFS {
        let port = (def.port)();
        let listening = tokio::task::spawn_blocking(move || check_port_listening(port))
            .await
            .unwrap_or(false);

        if !listening {
            continue;
        }

        let search = def.name.to_string();
        let pid = tokio::task::spawn_blocking(move || find_pid_by_cmdline(&search))
            .await
            .unwrap_or(None);

        if let Some(pid) = pid {
            let svc = ManagedService {
                name: def.name.to_string(),
                status: ProcessStatus::Running,
                pid,
                port,
                started_at: crate::utc_rfc3339(),
                exit_code: None,
                log_file: format!("{}/{}.log", LOG_DIR, def.name),
                running: true,
            };
            RUNNING_SERVICES
                .lock()
                .await
                .insert(def.name.to_string(), svc);
        }
    }
}

fn find_pid_by_cmdline(search: &str) -> Option<u32> {
    let proc_dir = std::fs::read_dir("/proc").ok()?;
    for entry in proc_dir.flatten() {
        let name = entry.file_name();
        let name_str = name.to_str()?;
        let pid: u32 = match name_str.parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let cmdline_path = format!("/proc/{}/cmdline", pid);
        if let Ok(cmdline) = std::fs::read_to_string(&cmdline_path) {
            if cmdline.contains(search) {
                return Some(pid);
            }
        }
    }
    None
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

    for def in SERVICE_DEFS {
        if let Some(svc) = services.get(def.name) {
            list.push(serde_json::to_value(svc).unwrap_or_default());
        } else {
            let port = (def.port)();
            list.push(serde_json::json!({
                "name": def.name,
                "status": "stopped",
                "pid": 0,
                "port": port,
                "startedAt": "",
                "exitCode": null,
                "logFile": format!("{}/{}.log", LOG_DIR, def.name),
                "running": false
            }));
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

    if let Some(def) = find_service_def(name) {
        let port = (def.port)();
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

    json_error(StatusCode::NOT_FOUND, &format!("Unknown service: {}", name))
}

pub async fn handle_service_start(name: &str) -> Response<Full<Bytes>> {
    let def = match find_service_def(name) {
        Some(d) => d,
        None => {
            return json_error(
                StatusCode::NOT_FOUND,
                &format!("Unknown service: {}", name),
            )
        }
    };

    let port = (def.port)();
    let command = (def.command_template)();

    {
        let services = RUNNING_SERVICES.lock().await;
        if let Some(existing) = services.get(name) {
            if existing.status == ProcessStatus::Running && is_process_running(existing.pid) {
                return json_error(
                    StatusCode::CONFLICT,
                    &format!(
                        "Service '{}' is already running with PID {}",
                        name, existing.pid
                    ),
                );
            }
        }
    }

    let log_file = format!("{}/{}.log", LOG_DIR, name);

    let log_handle = match tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_file)
        .await
    {
        Ok(f) => f,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };

    let wrapped_cmd = if def.user == "dev" {
        format!("su - dev -c \"{}\"", command.replace('"', "\\\""))
    } else {
        command
    };

    let mut cmd = Command::new("/bin/sh");
    cmd.args(["-c", &wrapped_cmd])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    };

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

    RUNNING_SERVICES.lock().await.insert(name_owned, svc);

    json_ok(serde_json::json!({
        "status": "running",
        "pid": pid,
        "name": name,
        "port": port,
        "logFile": log_file,
        "startedAt": started_at
    }))
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

    if find_service_def(name).is_none() {
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
