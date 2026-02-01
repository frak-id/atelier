use http_body_util::Full;
use hyper::body::Bytes;
use hyper::Response;
use std::sync::LazyLock;
use std::time::Instant;

use crate::config::SANDBOX_CONFIG;

static START_TIME: LazyLock<Instant> = LazyLock::new(Instant::now);

fn check_port_listening(port: u16) -> bool {
    let target = format!("{:04X}", port);

    for path in &["/proc/net/tcp", "/proc/net/tcp6"] {
        if let Ok(contents) = std::fs::read_to_string(path) {
            for line in contents.lines().skip(1) {
                let fields: Vec<&str> = line.split_whitespace().collect();
                if fields.len() < 4 {
                    continue;
                }
                let st = fields[3];
                if st != "0A" {
                    continue;
                }
                if let Some(port_hex) = fields[1].rsplit(':').next() {
                    if port_hex == target {
                        return true;
                    }
                }
            }
        }
    }
    false
}

fn get_cpu_usage() -> f64 {
    std::fs::read_to_string("/proc/loadavg")
        .ok()
        .and_then(|s| s.split_whitespace().next().and_then(|v| v.parse().ok()))
        .unwrap_or(0.0)
}

fn get_memory_usage() -> serde_json::Value {
    let parse = || -> Option<(u64, u64, u64)> {
        let contents = std::fs::read_to_string("/proc/meminfo").ok()?;
        let mut total = 0u64;
        let mut free = 0u64;
        let mut buffers = 0u64;
        let mut cached = 0u64;

        for line in contents.lines() {
            let mut parts = line.split(':');
            let key = parts.next()?.trim();
            let val_str = parts.next()?.trim();
            let val: u64 = val_str.split_whitespace().next()?.parse().ok()?;

            match key {
                "MemTotal" => total = val,
                "MemFree" => free = val,
                "Buffers" => buffers = val,
                "Cached" => cached = val,
                _ => {}
            }
        }

        let used = total.saturating_sub(free + buffers + cached);
        Some((total * 1024, used * 1024, (free + buffers + cached) * 1024))
    };

    match parse() {
        Some((total, used, free)) => serde_json::json!({ "total": total, "used": used, "free": free }),
        None => serde_json::json!({ "total": 0, "used": 0, "free": 0 }),
    }
}

fn get_disk_usage() -> serde_json::Value {
    let parse = || -> Option<(u64, u64, u64)> {
        let mut buf: libc::statvfs = unsafe { std::mem::zeroed() };
        let path = b"/\0";
        let ret = unsafe { libc::statvfs(path.as_ptr() as *const libc::c_char, &mut buf) };
        if ret != 0 {
            return None;
        }
        let total = buf.f_blocks as u64 * buf.f_frsize as u64;
        let free = buf.f_bfree as u64 * buf.f_frsize as u64;
        let used = total.saturating_sub(free);
        Some((total, used, free))
    };

    match parse() {
        Some((total, used, free)) => serde_json::json!({ "total": total, "used": used, "free": free }),
        None => serde_json::json!({ "total": 0, "used": 0, "free": 0 }),
    }
}

fn json_ok(body: serde_json::Value) -> Response<Full<Bytes>> {
    Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap()
}

pub async fn handle_health() -> Response<Full<Bytes>> {
    let _ = *START_TIME;

    let cfg = SANDBOX_CONFIG.as_ref();
    let services = cfg.map(|c| &c.services);

    let vscode = check_port_listening(services.map_or(8080, |s| s.vscode.port));
    let opencode = check_port_listening(services.map_or(3000, |s| s.opencode.port));
    let sshd = check_port_listening(22);
    let ttyd = check_port_listening(services.map_or(7681, |s| s.terminal.port));
    let browser = check_port_listening(services.and_then(|s| s.browser.as_ref()).map_or(6080, |b| b.port));

    let uptime = START_TIME.elapsed().as_secs_f64();

    json_ok(serde_json::json!({
        "status": "healthy",
        "sandboxId": cfg.map(|c| c.sandbox_id.as_str()),
        "services": {
            "vscode": vscode,
            "opencode": opencode,
            "sshd": sshd,
            "ttyd": ttyd,
            "browser": browser
        },
        "uptime": uptime
    }))
}

pub fn handle_metrics() -> Response<Full<Bytes>> {
    let now = chrono::Utc::now().to_rfc3339();

    json_ok(serde_json::json!({
        "cpu": get_cpu_usage(),
        "memory": get_memory_usage(),
        "disk": get_disk_usage(),
        "timestamp": now
    }))
}
