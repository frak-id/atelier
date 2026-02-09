use serde::Serialize;
use std::collections::HashMap;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::config::LOG_DIR;
use crate::response::json_ok;

const MAX_LOG_READ_BYTES: usize = 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsResponse {
    pub name: String,
    pub content: String,
    pub next_offset: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessStatus {
    Running,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedProcess {
    pub name: String,
    pub status: ProcessStatus,
    pub pid: u32,
    pub port: Option<u16>,
    pub started_at: String,
    pub exit_code: Option<i32>,
    pub log_file: String,
    pub running: bool,
}

pub struct StartParams<'a> {
    pub name: &'a str,
    pub command: &'a str,
    pub user: &'a str,
    pub workdir: Option<&'a str>,
    pub port: Option<u16>,
    pub env: Option<&'a HashMap<String, String>>,
    pub log_prefix: &'a str,
}

pub fn is_process_running(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: signal 0 only checks existence; PID validated non-zero above.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

pub fn signal_process(pid: u32, signal: i32) {
    if pid <= 1 {
        return;
    }
    // SAFETY: PID validated >1 above; callers only pass SIGTERM/SIGKILL.
    unsafe { libc::kill(pid as i32, signal) };
}

pub async fn pump_stream<R: tokio::io::AsyncRead + Unpin>(
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

pub async fn read_logs(
    name: &str,
    log_path: &str,
    query: &str,
) -> hyper::Response<http_body_util::Full<hyper::body::Bytes>> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let mut offset: u64 = 0;
    let mut limit: usize = 10000;

    for param in query.split('&') {
        let mut kv = param.splitn(2, '=');
        match (kv.next(), kv.next()) {
            (Some("offset"), Some(v)) => {
                offset = v.parse().unwrap_or(0)
            }
            (Some("limit"), Some(v)) => {
                limit = v.parse().unwrap_or(10000)
            }
            _ => {}
        }
    }

    limit = limit.min(MAX_LOG_READ_BYTES);

    let mut file = match tokio::fs::File::open(log_path).await {
        Ok(f) => f,
        Err(_) => {
            return json_ok(
                serde_json::to_value(LogsResponse {
                    name: name.to_string(),
                    content: String::new(),
                    next_offset: 0,
                })
                .unwrap(),
            );
        }
    };

    if offset > 0 {
        if file
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .is_err()
        {
            return json_ok(
                serde_json::to_value(LogsResponse {
                    name: name.to_string(),
                    content: String::new(),
                    next_offset: offset,
                })
                .unwrap(),
            );
        }
    }

    let mut buf = vec![0u8; limit];
    let n = match file.read(&mut buf).await {
        Ok(n) => n,
        Err(_) => 0,
    };
    buf.truncate(n);

    let content = String::from_utf8_lossy(&buf).to_string();
    let next_offset = offset + n as u64;

    json_ok(
        serde_json::to_value(LogsResponse {
            name: name.to_string(),
            content,
            next_offset,
        })
        .unwrap(),
    )
}

pub struct ProcessRegistry {
    processes: std::sync::Arc<Mutex<HashMap<String, ManagedProcess>>>,
}

impl ProcessRegistry {
    pub fn new() -> Self {
        Self {
            processes: std::sync::Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn start_process(
        &self,
        params: StartParams<'_>,
    ) -> Result<ManagedProcess, String> {
        {
            let procs = self.processes.lock().await;
            if let Some(existing) = procs.get(params.name) {
                if existing.status == ProcessStatus::Running
                    && is_process_running(existing.pid)
                {
                    return Err(format!(
                        "'{}' is already running with PID {}",
                        params.name, existing.pid
                    ));
                }
            }
        }

        let log_file = format!("{}/{}", LOG_DIR, params.log_prefix);

        let log_handle = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&log_file)
            .await
            .map_err(|e| e.to_string())?;

        let mut cmd = Command::new("/bin/bash");
        cmd.args(["-l", "-c", params.command])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        if params.user == "dev" {
            cmd.uid(1000).gid(1000);
            cmd.env("HOME", "/home/dev");
            cmd.env("USER", "dev");
        }

        if let Some(env_vars) = params.env {
            for (k, v) in env_vars.iter() {
                cmd.env(k, v);
            }
        }

        if let Some(dir) = params.workdir {
            cmd.current_dir(dir);
        }

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;

        let pid = child.id().unwrap_or(0);
        let started_at = crate::utc_rfc3339();

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let (_log_rd, log_wr) = tokio::io::split(log_handle);
        let log_wr =
            std::sync::Arc::new(tokio::sync::Mutex::new(log_wr));

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

        let name_owned = params.name.to_string();
        let child_pid = pid;
        let processes_arc = self.processes.clone();

        tokio::spawn(async move {
            let status = child.wait().await;
            let mut procs = processes_arc.lock().await;
            if let Some(proc_entry) = procs.get_mut(&name_owned) {
                if proc_entry.pid == child_pid {
                    match status {
                        Ok(s) => {
                            let code = s.code().unwrap_or(-1);
                            proc_entry.exit_code = Some(code);
                            proc_entry.status = if code == 0 {
                                ProcessStatus::Stopped
                            } else {
                                ProcessStatus::Error
                            };
                            proc_entry.running = false;
                        }
                        Err(_) => {
                            proc_entry.status =
                                ProcessStatus::Error;
                            proc_entry.running = false;
                        }
                    }
                }
            }
        });

        let port_val = params.port;

        let result = ManagedProcess {
            name: params.name.to_string(),
            status: ProcessStatus::Running,
            pid,
            port: port_val,
            started_at: started_at.clone(),
            exit_code: None,
            log_file: log_file.clone(),
            running: true,
        };

        self.processes.lock().await.insert(
            params.name.to_string(),
            ManagedProcess {
                name: params.name.to_string(),
                status: ProcessStatus::Running,
                pid,
                port: port_val,
                started_at,
                exit_code: None,
                log_file,
                running: true,
            },
        );

        Ok(result)
    }

    pub async fn stop_process(
        &self,
        name: &str,
        grace_ms: u64,
    ) -> StopResult {
        let mut procs = self.processes.lock().await;

        let proc_entry = match procs.get_mut(name) {
            Some(p) => p,
            None => return StopResult::NotFound,
        };

        if proc_entry.status != ProcessStatus::Running
            || !is_process_running(proc_entry.pid)
        {
            proc_entry.status = if proc_entry.exit_code == Some(0) {
                ProcessStatus::Stopped
            } else {
                ProcessStatus::Error
            };
            proc_entry.running = false;
            return StopResult::AlreadyStopped {
                status: proc_entry.status,
                exit_code: proc_entry.exit_code,
            };
        }

        let pid = proc_entry.pid;
        signal_process(pid, libc::SIGTERM);

        drop(procs);
        tokio::time::sleep(std::time::Duration::from_millis(
            grace_ms,
        ))
        .await;

        let mut procs = self.processes.lock().await;
        if is_process_running(pid) {
            signal_process(pid, libc::SIGKILL);
        }

        if let Some(p) = procs.get_mut(name) {
            p.status = ProcessStatus::Stopped;
            p.running = false;
            if p.exit_code.is_none() {
                p.exit_code = Some(-1);
            }
        }

        StopResult::Stopped { pid }
    }

    pub async fn list_processes(&self) -> Vec<ManagedProcess> {
        let mut procs = self.processes.lock().await;
        for proc_entry in procs.values_mut() {
            if proc_entry.status == ProcessStatus::Running
                && !is_process_running(proc_entry.pid)
            {
                proc_entry.status = ProcessStatus::Error;
                proc_entry.running = false;
            }
        }
        procs.values().cloned().collect()
    }

    pub async fn get_process(
        &self,
        name: &str,
    ) -> Option<ManagedProcess> {
        let mut procs = self.processes.lock().await;
        if let Some(p) = procs.get_mut(name) {
            if p.status == ProcessStatus::Running
                && !is_process_running(p.pid)
            {
                p.status = ProcessStatus::Error;
                p.running = false;
            }
            Some(p.clone())
        } else {
            None
        }
    }
}

pub enum StopResult {
    NotFound,
    AlreadyStopped {
        status: ProcessStatus,
        exit_code: Option<i32>,
    },
    Stopped {
        pid: u32,
    },
}
