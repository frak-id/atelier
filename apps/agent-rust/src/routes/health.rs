use http_body_util::Full;
use hyper::body::Bytes;
use hyper::Response;
use std::sync::LazyLock;
use std::time::Instant;

use crate::config::get_config;
use crate::response::json_ok;

static START_TIME: LazyLock<Instant> = LazyLock::new(Instant::now);

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

    let sandbox_id = get_config().map(|c| c.sandbox_id);

    let uptime = START_TIME.elapsed().as_secs_f64();

    json_ok(serde_json::json!({
        "status": "healthy",
        "sandboxId": sandbox_id,
        "uptime": uptime
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
