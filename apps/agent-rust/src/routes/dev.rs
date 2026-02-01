use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::{Request, Response};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::LazyLock;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::config::{LOG_DIR, WORKSPACE_DIR};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DevProcessInfo {
    name: String,
    status: String,
    pid: u32,
    port: Option<u16>,
    started_at: String,
    exit_code: Option<i32>,
    log_file: String,
}

struct DevProcess {
    pid: u32,
    name: String,
    log_file: String,
    started_at: String,
    port: Option<u16>,
    status: String,
    exit_code: Option<i32>,
}

static RUNNING_DEV_COMMANDS: LazyLock<Mutex<HashMap<String, DevProcess>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn is_process_running(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn json_ok(body: serde_json::Value) -> Response<Full<Bytes>> {
    Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap()
}

fn json_status(status: u16, body: serde_json::Value) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap()
}

pub fn handle_get_dev() -> Response<Full<Bytes>> {
    let commands = RUNNING_DEV_COMMANDS.blocking_lock();
    let list: Vec<DevProcessInfo> = commands
        .values()
        .map(|proc| {
            let status = if proc.status == "running" && !is_process_running(proc.pid) {
                "error".to_string()
            } else {
                proc.status.clone()
            };
            DevProcessInfo {
                name: proc.name.clone(),
                status,
                pid: proc.pid,
                port: proc.port,
                started_at: proc.started_at.clone(),
                exit_code: proc.exit_code,
                log_file: proc.log_file.clone(),
            }
        })
        .collect();

    json_ok(serde_json::json!({ "commands": list }))
}

pub async fn handle_dev_start(name: &str, req: Request<hyper::body::Incoming>) -> Response<Full<Bytes>> {
    let body = match req.collect().await.map(|b| b.to_bytes()) {
        Ok(b) => b,
        Err(_) => return json_status(400, serde_json::json!({"error": "Failed to read body"})),
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
        Err(_) => return json_status(400, serde_json::json!({"error": "Invalid JSON"})),
    };

    let mut commands = RUNNING_DEV_COMMANDS.lock().await;

    if let Some(existing) = commands.get(name) {
        if existing.status == "running" && is_process_running(existing.pid) {
            return json_status(409, serde_json::json!({
                "error": "Conflict",
                "message": format!("Dev command '{}' is already running with PID {}", name, existing.pid)
            }));
        }
    }

    let log_file = format!("{}/dev-{}.log", LOG_DIR, name);

    let log_handle = match tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file)
        .await
    {
        Ok(f) => f,
        Err(e) => return json_status(500, serde_json::json!({"error": e.to_string()})),
    };

    let workdir = parsed.workdir.unwrap_or_else(|| WORKSPACE_DIR.to_string());

    let mut cmd = Command::new("/bin/sh");
    cmd.args(["-c", &parsed.command])
        .current_dir(&workdir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if let Some(env_vars) = &parsed.env {
        for (k, v) in env_vars {
            cmd.env(k, v);
        }
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return json_status(500, serde_json::json!({"error": e.to_string()})),
    };

    let pid = child.id().unwrap_or(0);
    let started_at = chrono::Utc::now().to_rfc3339();

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let (log_rd, log_wr) = tokio::io::split(log_handle);
    drop(log_rd);
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
    let wait_child_name = name_owned.clone();

    // Wait on child OUTSIDE the lock to avoid deadlock, then re-acquire to update status
    tokio::spawn(async move {
        let status = child.wait().await;
        let mut cmds = RUNNING_DEV_COMMANDS.lock().await;
        if let Some(proc) = cmds.get_mut(&wait_child_name) {
            if proc.pid == child_pid {
                match status {
                    Ok(s) => {
                        let code = s.code().unwrap_or(-1);
                        proc.exit_code = Some(code);
                        proc.status = if code == 0 { "stopped" } else { "error" }.to_string();
                    }
                    Err(_) => {
                        proc.status = "error".to_string();
                    }
                }
            }
        }
    });

    let dev_proc = DevProcess {
        pid,
        name: name_owned.clone(),
        log_file: log_file.clone(),
        started_at: started_at.clone(),
        port: parsed.port,
        status: "running".to_string(),
        exit_code: None,
    };

    commands.insert(name_owned, dev_proc);

    json_ok(serde_json::json!({
        "status": "running",
        "pid": pid,
        "name": name,
        "port": parsed.port,
        "logFile": log_file,
        "startedAt": started_at
    }))
}

async fn pump_stream<R: tokio::io::AsyncRead + Unpin>(
    reader: R,
    writer: std::sync::Arc<tokio::sync::Mutex<tokio::io::WriteHalf<tokio::fs::File>>>,
) {
    use tokio::io::AsyncReadExt;
    let mut reader = reader;
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(n) => {
                let mut w = writer.lock().await;
                let _ = w.write_all(&buf[..n]).await;
            }
            Err(_) => break,
        }
    }
}

pub async fn handle_dev_stop(name: &str) -> Response<Full<Bytes>> {
    let mut commands = RUNNING_DEV_COMMANDS.lock().await;

    let proc = match commands.get_mut(name) {
        Some(p) => p,
        None => {
            return json_ok(serde_json::json!({
                "status": "stopped",
                "name": name,
                "message": "Command not found or already stopped"
            }));
        }
    };

    if proc.status != "running" || !is_process_running(proc.pid) {
        let status = if proc.exit_code == Some(0) { "stopped" } else { "error" };
        proc.status = status.to_string();
        return json_ok(serde_json::json!({
            "status": status,
            "name": name,
            "exitCode": proc.exit_code,
            "message": "Command already stopped"
        }));
    }

    let pid = proc.pid;
    unsafe { libc::kill(pid as i32, libc::SIGTERM) };
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    if is_process_running(pid) {
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    }

    proc.status = "stopped".to_string();
    if proc.exit_code.is_none() {
        proc.exit_code = Some(-1);
    }

    json_ok(serde_json::json!({
        "status": "stopped",
        "name": name,
        "pid": pid,
        "message": "Command stopped"
    }))
}

pub async fn handle_dev_logs(name: &str, query: &str) -> Response<Full<Bytes>> {
    let mut offset: usize = 0;
    let mut limit: usize = 10000;

    for param in query.split('&') {
        let mut kv = param.splitn(2, '=');
        match (kv.next(), kv.next()) {
            (Some("offset"), Some(v)) => offset = v.parse().unwrap_or(0),
            (Some("limit"), Some(v)) => limit = v.parse().unwrap_or(10000),
            _ => {}
        }
    }

    let log_path = format!("{}/dev-{}.log", LOG_DIR, name);

    let content = match tokio::fs::read_to_string(&log_path).await {
        Ok(s) => s,
        Err(_) => String::new(),
    };

    let end = (offset + limit).min(content.len());
    let chunk = if offset < content.len() {
        &content[offset..end]
    } else {
        ""
    };
    let next_offset = offset + chunk.len();

    json_ok(serde_json::json!({
        "name": name,
        "content": chunk,
        "nextOffset": next_offset
    }))
}
