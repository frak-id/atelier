//! Sandbox activity measurement for idle auto-pause
//! (docs/proposals/sandbox-idle-autopause.md §3.1). The agent *measures*:
//! network bytes (interface counters), file writes under the home (where
//! repos are cloned), CPU time, into one-minute buckets over the last hour.
//! The server *judges* (thresholds, idle rules): `GET /activity` hands it the
//! raw buckets.
//!
//! The file watcher (fanotify) is Linux-only; elsewhere it reports
//! `unavailable`, so the crate keeps building and testing on a developer's
//! Mac.

pub mod control;
mod cpu;
// Off Linux the sensors are stubs, leaving their parsers unused there.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod files;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod netdev;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Bucket width. The server rebases bucket starts onto its own clock.
pub const BUCKET_SECS: u64 = 60;
/// Buckets kept: the last hour.
const WINDOW_BUCKETS: u64 = 60;
/// How often network and CPU are sampled.
const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Default)]
struct Bucket {
    /// Unix minute (`secs / 60`).
    minute: u64,
    received_bytes: u64,
    sent_bytes: u64,
    file_writes: u64,
    cpu_ms: u64,
}

/// What one network sample measured since the previous one.
#[derive(Debug, Default)]
pub struct NetDelta {
    pub received: u64,
    pub sent: u64,
}

struct Inner {
    buckets: VecDeque<Bucket>,
    network: &'static str,
    files: &'static str,
    cpu: &'static str,
}

/// The shared measurement state: written by the samplers, read by
/// `GET /activity`. A std mutex: the file watcher is a blocking thread.
pub struct Activity {
    inner: Mutex<Inner>,
    booted_at_ms: u64,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

impl Activity {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                buckets: VecDeque::new(),
                network: "pending",
                files: "pending",
                cpu: "pending",
            }),
            booted_at_ms: now_ms(),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A panicking writer can't leave a bucket half-valid in a way that
        // matters (counters only), so a poisoned lock is still usable.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Add to the bucket of minute `now / 60`, dropping buckets older than
    /// the window.
    fn record(&self, now: u64, f: impl FnOnce(&mut Bucket)) {
        let minute = now / BUCKET_SECS;
        let mut inner = self.lock();
        let buckets = &mut inner.buckets;
        while buckets
            .front()
            .is_some_and(|b| b.minute + WINDOW_BUCKETS <= minute)
        {
            buckets.pop_front();
        }
        if buckets.back().is_none_or(|b| b.minute < minute) {
            buckets.push_back(Bucket {
                minute,
                ..Bucket::default()
            });
        }
        // A sample can't land in an older minute than the newest one (the
        // clock only goes back on a guest clock step): fold it into the last.
        if let Some(bucket) = buckets.back_mut() {
            f(bucket);
        }
    }

    pub fn add_network(&self, delta: &NetDelta) {
        self.add_network_at(now_secs(), delta);
    }

    fn add_network_at(&self, now: u64, delta: &NetDelta) {
        if delta.received == 0 && delta.sent == 0 {
            return;
        }
        self.record(now, |b| {
            b.received_bytes += delta.received;
            b.sent_bytes += delta.sent;
        });
    }

    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn add_file_write(&self) {
        self.record(now_secs(), |b| b.file_writes += 1);
    }

    pub fn add_cpu_ms(&self, ms: u64) {
        if ms > 0 {
            self.record(now_secs(), |b| b.cpu_ms += ms);
        }
    }

    pub fn set_network_status(&self, status: &'static str) {
        self.lock().network = status;
    }

    pub fn set_files_status(&self, status: &'static str) {
        self.lock().files = status;
    }

    pub fn set_cpu_status(&self, status: &'static str) {
        self.lock().cpu = status;
    }

    /// The `GET /activity` body.
    pub fn report(&self) -> serde_json::Value {
        let inner = self.lock();
        serde_json::json!({
            "nowMs": now_ms(),
            "bootedAtMs": self.booted_at_ms,
            "bucketSeconds": BUCKET_SECS,
            "network": inner.network,
            "files": inner.files,
            "cpu": inner.cpu,
            "buckets": inner
                .buckets
                .iter()
                .map(|b| serde_json::json!({
                    "startMs": b.minute * BUCKET_SECS * 1000,
                    "receivedBytes": b.received_bytes,
                    "sentBytes": b.sent_bytes,
                    "fileWrites": b.file_writes,
                    "cpuMs": b.cpu_ms,
                }))
                .collect::<Vec<_>>(),
        })
    }
}

/// Start the samplers: network + CPU every few seconds on the runtime, the
/// file watcher on its own blocking thread. Runs for the agent's lifetime.
pub fn spawn(activity: Arc<Activity>) {
    files::spawn_watcher(activity.clone());
    tokio::spawn(async move {
        let mut net = netdev::NetdevSampler::default();
        let mut cpu = cpu::CpuSampler::detect();
        let mut ticker = tokio::time::interval(SAMPLE_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            // /proc and cgroup reads are blocking syscalls.
            let sampled = tokio::task::spawn_blocking(move || {
                let delta = netdev::read().map(|read| net.account(read, control::totals()));
                let cpu_ms = cpu.sample();
                (net, cpu, delta, cpu_ms)
            })
            .await;
            let Ok((n, c, delta, cpu_ms)) = sampled else {
                eprintln!("atelier-agent: activity sampler panicked; stopping it");
                activity.set_network_status("unavailable");
                activity.set_cpu_status("unavailable");
                return;
            };
            net = n;
            cpu = c;
            activity.set_network_status(if delta.is_some() {
                "netdev"
            } else {
                "unavailable"
            });
            activity.set_cpu_status(cpu.status());
            if let Some(delta) = delta {
                activity.add_network(&delta);
            }
            activity.add_cpu_ms(cpu_ms);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn received(bytes: u64) -> NetDelta {
        NetDelta {
            received: bytes,
            sent: 0,
        }
    }

    #[test]
    fn buckets_roll_per_minute_and_keep_one_hour() {
        let a = Activity::new();
        let t0 = 1_000 * BUCKET_SECS;
        a.add_network_at(t0, &received(10));
        a.add_network_at(t0 + 30, &received(10));
        a.add_network_at(t0 + BUCKET_SECS, &received(10));
        {
            let inner = a.lock();
            assert_eq!(inner.buckets.len(), 2);
            assert_eq!(inner.buckets[0].received_bytes, 20);
        }
        // An hour later, the first two minutes are gone.
        a.add_network_at(t0 + WINDOW_BUCKETS * BUCKET_SECS + 1, &received(10));
        let inner = a.lock();
        let minutes: Vec<u64> = inner.buckets.iter().map(|b| b.minute).collect();
        assert_eq!(minutes, vec![1_001, 1_060]);
    }

    #[test]
    fn report_lists_measured_minutes_only() {
        let a = Activity::new();
        let t0 = 2_000 * BUCKET_SECS;
        a.add_network_at(
            t0,
            &NetDelta {
                received: 100,
                sent: 50,
            },
        );
        a.add_network_at(
            t0 + BUCKET_SECS,
            &NetDelta {
                received: 0,
                sent: 7,
            },
        );
        // Nothing measured: no bucket is created.
        a.add_network_at(t0 + 2 * BUCKET_SECS, &NetDelta::default());

        let report = a.report();
        let buckets = report["buckets"].as_array().unwrap();
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0]["startMs"], t0 * 1000);
        assert_eq!(buckets[0]["receivedBytes"], 100);
        assert_eq!(buckets[0]["sentBytes"], 50);
        assert_eq!(buckets[1]["sentBytes"], 7);
        assert_eq!(report["network"], "pending");
    }
}
