use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

pub const VSOCK_PORT: u32 = 9998;
pub const LOG_DIR: &str = "/var/log/sandbox";
pub const WORKSPACE_DIR: &str = "/home/dev/workspace";
pub const DEFAULT_EXEC_TIMEOUT_MS: u64 = 30_000;

pub const CONFIG_PATH: &str = "/etc/sandbox/config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceConfig {
    pub port: Option<u16>,
    pub command: Option<String>,
    pub user: Option<String>,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub env: Option<HashMap<String, String>>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConfig {
    pub dashboard_domain: String,
    pub manager_internal_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoConfig {
    pub clone_path: String,
    pub branch: String,
}

pub type SandboxServices = HashMap<String, ServiceConfig>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxConfig {
    pub sandbox_id: String,
    pub workspace_id: Option<String>,
    pub workspace_name: Option<String>,
    #[serde(default)]
    pub repos: Vec<RepoConfig>,
    pub created_at: String,
    pub network: NetworkConfig,
    pub services: SandboxServices,
}

pub static SANDBOX_CONFIG: LazyLock<RwLock<Option<SandboxConfig>>> = LazyLock::new(|| {
    let config = std::fs::read_to_string(CONFIG_PATH)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    RwLock::new(config)
});

/// Set config from JSON and write to disk
pub fn set_config(config: SandboxConfig) -> Result<(), String> {
    let content =
        serde_json::to_string_pretty(&config).map_err(|e| format!("Failed to serialize: {}", e))?;
    std::fs::write(CONFIG_PATH, &content).map_err(|e| format!("Failed to write config: {}", e))?;
    let mut guard = SANDBOX_CONFIG
        .write()
        .map_err(|e| format!("Lock poisoned: {}", e))?;
    *guard = Some(config);
    Ok(())
}

/// Get a clone of current config
pub fn get_config() -> Option<SandboxConfig> {
    SANDBOX_CONFIG.read().ok().and_then(|g| g.clone())
}
