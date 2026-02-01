use http_body_util::Full;
use hyper::body::Bytes;
use hyper::Response;
use std::sync::LazyLock;
use std::time::Instant;

use crate::config::SANDBOX_CONFIG;
use crate::response::json_ok;

static START_TIME: LazyLock<Instant> = LazyLock::new(Instant::now);

pub fn check_port_listening(port: u16) -> bool {
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

pub async fn handle_health() -> Response<Full<Bytes>> {
    let _ = *START_TIME;

    let cfg = SANDBOX_CONFIG.as_ref();
    let sandbox_id = cfg.map(|c| c.sandbox_id.clone());

    let mut port_checks: Vec<(String, u16)> = Vec::new();
    if let Some(c) = cfg {
        for (name, svc) in &c.services {
            if let Some(port) = svc.port {
                port_checks.push((name.clone(), port));
            }
        }
    }
    // Always check sshd
    port_checks.push(("sshd".to_string(), 22));

    let results = tokio::task::spawn_blocking(move || {
        let mut map = serde_json::Map::new();
        for (name, port) in &port_checks {
            map.insert(
                name.clone(),
                serde_json::Value::Bool(check_port_listening(*port)),
            );
        }
        let uptime = START_TIME.elapsed().as_secs_f64();
        (map, uptime)
    })
    .await
    .unwrap_or_else(|_| (serde_json::Map::new(), 0.0));

    json_ok(serde_json::json!({
        "status": "healthy",
        "sandboxId": sandbox_id,
        "services": serde_json::Value::Object(results.0),
        "uptime": results.1
    }))
}

pub async fn handle_metrics() -> Response<Full<Bytes>> {
    let (cpu, memory, disk) = tokio::task::spawn_blocking(|| {
        (get_cpu_usage(), get_memory_usage(), get_disk_usage())
    })
    .await
    .unwrap_or_else(|_| {
        let empty = serde_json::json!({"total": 0, "used": 0, "free": 0});
        (0.0, empty.clone(), empty)
    });

    let now = crate::utc_rfc3339();

    json_ok(serde_json::json!({
        "cpu": cpu,
        "memory": memory,
        "disk": disk,
        "timestamp": now
    }))
}
