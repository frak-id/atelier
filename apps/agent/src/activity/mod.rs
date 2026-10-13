//! Sandbox activity measurement for idle auto-pause
//! (docs/proposals/sandbox-idle-autopause.md §3.1). The agent *measures*:
//! network bytes (inbound/outbound, per process, or per interface where the
//! guest kernel lacks `inet_diag`), file writes under the roots (the home,
//! where repos are cloned), CPU time, into one-minute buckets over the last
//! hour.
//! The server *judges* (thresholds, idle rules): `GET /activity` hands it the
//! raw buckets. The one exception is the file filter (roots + excludes),
//! which has to be applied at the source; the server pushes it through
//! `PUT /activity/settings`.
//!
//! Linux-only sensors (netlink sock_diag, fanotify/inotify) are cfg-gated;
//! elsewhere they report `unavailable`, so the crate keeps building and
//! testing on a developer's Mac.

pub mod control;
mod cpu;
// Off Linux the sensors are stubs, leaving their parsers unused there.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod files;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod net;
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod netdev;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::supervisor::Supervisor;

/// Bucket width. The server rebases bucket starts onto its own clock.
pub const BUCKET_SECS: u64 = 60;
/// Buckets kept: the last hour.
const WINDOW_BUCKETS: u64 = 60;
/// How often network and CPU are sampled.
const SAMPLE_INTERVAL: Duration = Duration::from_secs(5);

/// Bytes of one process (or forwarded port's listener) in a bucket.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ProcessBytes {
    supervised: bool,
    inbound: u64,
    outbound: u64,
}

#[derive(Debug, Clone, Default)]
struct Bucket {
    /// Unix minute (`secs / 60`).
    minute: u64,
    inbound_bytes: u64,
    outbound_bytes: u64,
    file_writes: u64,
    cpu_ms: u64,
    by_process: HashMap<String, ProcessBytes>,
}

impl Bucket {
    fn is_empty(&self) -> bool {
        self.inbound_bytes == 0
            && self.outbound_bytes == 0
            && self.file_writes == 0
            && self.cpu_ms == 0
    }
}

/// Who a socket's bytes belong to (see net.rs `Owner`).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Owner {
    /// The supervised process name from the spec, else the process `comm`.
    pub name: String,
    pub supervised: bool,
}

/// What one network sample measured since the previous one.
#[derive(Debug, Default)]
pub struct NetDelta {
    pub inbound: u64,
    pub outbound: u64,
    pub by_owner: Vec<(Owner, u64, u64)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileSettings {
    pub roots: Vec<String>,
    pub exclude: Vec<String>,
}

impl Default for FileSettings {
    /// Same defaults as the server's `sandbox.idle.fileRoots` /
    /// `fileExcludes`, so an agent the server hasn't reached yet already
    /// filters sensibly. Repos are cloned into the home (`/home/dev/<repo>`);
    /// its hidden top-level entries are tool state (caches, editor servers,
    /// shell history, agent config).
    fn default() -> Self {
        Self {
            roots: vec!["/home/dev".into()],
            exclude: [
                "node_modules",
                ".git",
                ".next",
                ".nuxt",
                ".turbo",
                ".cache",
                "dist",
                "build",
                "target",
                "*.log",
                "/home/dev/.*",
            ]
            .map(String::from)
            .to_vec(),
        }
    }
}

struct Inner {
    buckets: VecDeque<Bucket>,
    settings: FileSettings,
    /// Bumped on every settings change, so the file watcher re-reads them.
    settings_version: u64,
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
                settings: FileSettings::default(),
                settings_version: 0,
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
        if delta.inbound == 0 && delta.outbound == 0 {
            return;
        }
        self.record(now, |b| {
            b.inbound_bytes += delta.inbound;
            b.outbound_bytes += delta.outbound;
            for (owner, inbound, outbound) in &delta.by_owner {
                let entry = b.by_process.entry(owner.name.clone()).or_default();
                entry.supervised |= owner.supervised;
                entry.inbound += inbound;
                entry.outbound += outbound;
            }
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

    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn settings(&self) -> (FileSettings, u64) {
        let inner = self.lock();
        (inner.settings.clone(), inner.settings_version)
    }

    pub fn set_settings(&self, settings: FileSettings) {
        let mut inner = self.lock();
        if inner.settings != settings {
            inner.settings = settings;
            inner.settings_version += 1;
        }
    }

    /// The `GET /activity` body.
    pub fn report(&self) -> serde_json::Value {
        let inner = self.lock();
        let mut processes: HashMap<&str, ProcessBytes> = HashMap::new();
        for bucket in &inner.buckets {
            for (name, bytes) in &bucket.by_process {
                let entry = processes.entry(name).or_default();
                entry.supervised |= bytes.supervised;
                entry.inbound += bytes.inbound;
                entry.outbound += bytes.outbound;
            }
        }
        let mut processes: Vec<_> = processes.into_iter().collect();
        processes.sort_by(|a, b| a.0.cmp(b.0));
        serde_json::json!({
            "nowMs": now_ms(),
            "bootedAtMs": self.booted_at_ms,
            "bucketSeconds": BUCKET_SECS,
            "network": inner.network,
            "files": inner.files,
            "cpu": inner.cpu,
            "fileSettings": inner.settings,
            "buckets": inner
                .buckets
                .iter()
                .filter(|b| !b.is_empty())
                .map(|b| serde_json::json!({
                    "startMs": b.minute * BUCKET_SECS * 1000,
                    "inboundBytes": b.inbound_bytes,
                    "outboundBytes": b.outbound_bytes,
                    "fileWrites": b.file_writes,
                    "cpuMs": b.cpu_ms,
                }))
                .collect::<Vec<_>>(),
            "processes": processes
                .into_iter()
                .map(|(name, bytes)| serde_json::json!({
                    "name": name,
                    "supervised": bytes.supervised,
                    "inboundBytes": bytes.inbound,
                    "outboundBytes": bytes.outbound,
                }))
                .collect::<Vec<_>>(),
        })
    }
}

/// Start the samplers: network + CPU every few seconds on the runtime, the
/// file watcher on its own blocking thread. Runs for the agent's lifetime.
pub fn spawn(activity: Arc<Activity>, supervisor: Arc<Supervisor>) {
    files::spawn_watcher(activity.clone());
    tokio::spawn(async move {
        let mut net = net::NetSampler::new().with_destroy_events();
        let mut cpu = cpu::CpuSampler::detect();
        activity.set_network_status(net.status());
        activity.set_cpu_status(cpu.status());
        let mut ticker = tokio::time::interval(SAMPLE_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            // Supervised processes run in their own process group (pgid =
            // their pid, supervisor.rs), which is how a socket's owner maps
            // back to its spec name.
            let groups: HashMap<u32, String> = supervisor
                .list()
                .await
                .into_iter()
                .filter(|p| p.pid > 1)
                .map(|p| (p.pid, p.name))
                .collect();
            // netlink + /proc scans are blocking syscalls.
            let sampled = tokio::task::spawn_blocking(move || {
                let delta = net.sample(&groups);
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
            activity.set_network_status(net.status());
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

    fn owner(name: &str, supervised: bool) -> Owner {
        Owner {
            name: name.into(),
            supervised,
        }
    }

    #[test]
    fn buckets_roll_per_minute_and_keep_one_hour() {
        let a = Activity::new();
        let t0 = 1_000 * BUCKET_SECS;
        let delta = NetDelta {
            inbound: 10,
            outbound: 0,
            by_owner: vec![],
        };
        a.add_network_at(t0, &delta);
        a.add_network_at(t0 + 30, &delta);
        a.add_network_at(t0 + BUCKET_SECS, &delta);
        {
            let inner = a.lock();
            assert_eq!(inner.buckets.len(), 2);
            assert_eq!(inner.buckets[0].inbound_bytes, 20);
        }
        // An hour later, the first two minutes are gone.
        a.add_network_at(t0 + WINDOW_BUCKETS * BUCKET_SECS + 1, &delta);
        let inner = a.lock();
        let minutes: Vec<u64> = inner.buckets.iter().map(|b| b.minute).collect();
        assert_eq!(minutes, vec![1_001, 1_060]);
    }

    #[test]
    fn report_sums_processes_and_skips_empty_buckets() {
        let a = Activity::new();
        let t0 = 2_000 * BUCKET_SECS;
        a.add_network_at(
            t0,
            &NetDelta {
                inbound: 100,
                outbound: 50,
                by_owner: vec![
                    (owner("code-server", true), 100, 0),
                    (owner("git", false), 0, 50),
                ],
            },
        );
        a.add_network_at(
            t0 + BUCKET_SECS,
            &NetDelta {
                inbound: 0,
                outbound: 7,
                by_owner: vec![(owner("git", false), 0, 7)],
            },
        );
        // Nothing measured: no bucket is created.
        a.add_network_at(t0 + 2 * BUCKET_SECS, &NetDelta::default());

        let report = a.report();
        let buckets = report["buckets"].as_array().unwrap();
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0]["startMs"], t0 * 1000);
        assert_eq!(buckets[0]["inboundBytes"], 100);
        assert_eq!(buckets[1]["outboundBytes"], 7);
        assert_eq!(
            report["processes"],
            serde_json::json!([
                { "name": "code-server", "supervised": true, "inboundBytes": 100, "outboundBytes": 0 },
                { "name": "git", "supervised": false, "inboundBytes": 0, "outboundBytes": 57 },
            ])
        );
        assert_eq!(report["fileSettings"]["roots"][0], "/home/dev");
    }

    #[test]
    fn settings_bump_their_version_only_on_change() {
        let a = Activity::new();
        let (initial, v0) = a.settings();
        a.set_settings(initial.clone());
        assert_eq!(a.settings().1, v0);
        a.set_settings(FileSettings {
            roots: vec!["/srv".into()],
            exclude: vec![],
        });
        let (now, v1) = a.settings();
        assert_eq!(v1, v0 + 1);
        assert_eq!(now.roots, vec!["/srv".to_string()]);
    }

    #[test]
    fn settings_reject_unknown_fields() {
        assert!(serde_json::from_str::<FileSettings>(r#"{"roots":[],"exclude":[]}"#).is_ok());
        assert!(
            serde_json::from_str::<FileSettings>(r#"{"roots":[],"exclude":[],"nope":1}"#).is_err()
        );
    }
}
