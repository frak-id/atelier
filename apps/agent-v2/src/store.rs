//! Mutable config store, swappable at runtime (not a read-once-at-boot
//! static).
//!
//! The runtime *pushes* config over HTTP (`PUT /config`); the store swaps it
//! atomically, persists a copy for crash-restart recovery, and notifies
//! watchers (supervisor, forwarder) so they reconcile against the new desired
//! state. No inotify, no polling: the only writer is the runtime, and it
//! talks to us directly.
//!
//! Persisted to `/run` (tmpfs) — never the ConfigMap mount, because pushed
//! config carries resolved secret values in per-process `env` that must not
//! land in etcd or on the disk snapshot a pause promotes.

use std::sync::{Arc, RwLock};

use tokio::sync::watch;

use crate::config::AgentConfig;

pub const PERSIST_PATH: &str = "/run/atelier-agent/config.json";

pub struct ConfigStore {
    current: RwLock<Option<Arc<AgentConfig>>>,
    tx: watch::Sender<u64>,
    version: std::sync::atomic::AtomicU64,
}

impl ConfigStore {
    fn new(initial: Option<AgentConfig>) -> Self {
        let (tx, _) = watch::channel(0);
        Self {
            current: RwLock::new(initial.map(Arc::new)),
            tx,
            version: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Seed a store directly (tests only — production always `load()`s then
    /// receives the runtime's push).
    #[cfg(test)]
    pub fn new_for_test(initial: Option<AgentConfig>) -> Self {
        Self::new(initial)
    }

    /// Load persisted config if present (agent crash-restart within a live
    /// pod); otherwise start empty and wait for the runtime's push.
    pub fn load() -> Self {
        let initial = std::fs::read(PERSIST_PATH)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<AgentConfig>(&bytes).ok());
        if initial.is_some() {
            println!("config: recovered persisted config from {PERSIST_PATH}");
        }
        Self::new(initial)
    }

    /// Current config snapshot (cheap Arc clone under a read lock).
    pub fn get(&self) -> Option<Arc<AgentConfig>> {
        self.current.read().expect("config lock poisoned").clone()
    }

    /// Validate, swap, persist, notify watchers. The whole write path.
    pub async fn set(&self, config: AgentConfig) -> Result<(), String> {
        config.validate()?;
        let serialized =
            serde_json::to_vec(&config).map_err(|e| format!("serialize config: {e}"))?;

        *self.current.write().expect("config lock poisoned") = Some(Arc::new(config));
        let v = self
            .version
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        // Persist best-effort: a failed write only degrades crash-restart
        // recovery, never the live swap.
        if let Err(e) = persist(&serialized).await {
            eprintln!("config: failed to persist to {PERSIST_PATH}: {e}");
        }
        let _ = self.tx.send(v);
        Ok(())
    }

    /// Subscribe to config-change notifications. Receivers get the monotonic
    /// version; they re-read `get()` for the actual state (level-triggered).
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.tx.subscribe()
    }
}

async fn persist(bytes: &[u8]) -> std::io::Result<()> {
    let dir = std::path::Path::new(PERSIST_PATH)
        .parent()
        .expect("PERSIST_PATH has a parent");
    tokio::fs::create_dir_all(dir).await?;
    // Write-then-rename so a crash mid-write never leaves a torn file.
    let tmp = format!("{PERSIST_PATH}.tmp");
    tokio::fs::write(&tmp, bytes).await?;
    tokio::fs::rename(&tmp, PERSIST_PATH).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Hooks;
    use std::collections::HashMap;

    fn cfg(id: &str) -> AgentConfig {
        AgentConfig {
            sandbox_id: id.into(),
            env: HashMap::new(),
            processes: vec![],
            ports: vec![],
            hooks: Hooks::default(),
        }
    }

    #[tokio::test]
    async fn set_swaps_and_notifies() {
        let store = ConfigStore::new(None);
        assert!(store.get().is_none());

        let mut rx = store.subscribe();
        store.set(cfg("sb_1")).await.expect("set");

        assert_eq!(store.get().expect("some").sandbox_id, "sb_1");
        rx.changed().await.expect("notified");

        store.set(cfg("sb_2")).await.expect("set again");
        assert_eq!(store.get().expect("some").sandbox_id, "sb_2");
    }

    #[tokio::test]
    async fn set_rejects_invalid_config() {
        let store = ConfigStore::new(None);
        let mut invalid = cfg("sb");
        invalid.processes = vec![
            crate::config::ProcessEntry {
                name: "a".into(),
                command: "true".into(),
                cwd: None,
                env: None,
                user: None,
                primary: false,
                stdio: crate::config::StdioMode::None,
                pty: false,
                readiness: None,
                after: vec![],
                restart: crate::config::RestartPolicy::Never,
                lazy: false,
            };
            2
        ];
        assert!(store.set(invalid).await.is_err());
        assert!(store.get().is_none(), "failed set must not swap");
    }
}
