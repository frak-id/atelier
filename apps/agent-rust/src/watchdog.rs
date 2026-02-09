use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

static LAST_TICK: LazyLock<AtomicU64> = LazyLock::new(|| AtomicU64::new(0));

pub const HEARTBEAT_PATH: &str = "/run/sandbox-agent.heartbeat";
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(2);
const HANG_TIMEOUT: Duration = Duration::from_secs(30);

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub fn start() {
    LAST_TICK.store(now_secs(), Ordering::Relaxed);

    // Async heartbeat writer: proves the runtime is making progress.
    tokio::spawn(async {
        loop {
            let ts = now_secs();
            LAST_TICK.store(ts, Ordering::Relaxed);
            let _ = tokio::fs::write(HEARTBEAT_PATH, ts.to_string()).await;
            tokio::time::sleep(HEARTBEAT_INTERVAL).await;
        }
    });

    // Separate OS thread: if the Tokio runtime deadlocks/hangs, this still runs.
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(5));
        let last = LAST_TICK.load(Ordering::Relaxed);
        if last == 0 {
            continue;
        }
        let age = now_secs().saturating_sub(last);
        if age > HANG_TIMEOUT.as_secs() {
            eprintln!(
                "watchdog: no progress for {age}s (>{}s), aborting",
                HANG_TIMEOUT.as_secs()
            );
            std::process::abort();
        }
    });
}
