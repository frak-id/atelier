use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, RwLock};

pub const AGENT_PORT: u16 = 9998;
// Fallback forwarder ports, used only when config.json carries no `devForwarder`
// (pre-existing blobs). The live values come from the manager's
// `config.ports.dev`/`devApp` via `SandboxConfig.dev_forwarder`; these defaults
// just match the manager's own defaults so an un-overridden setup still works.
pub const DEV_PORT: u16 = 3001;
pub const DEV_APP_PORT: u16 = 5173;
pub const LOG_DIR: &str = "/var/log/sandbox";
pub const DEFAULT_EXEC_TIMEOUT_MS: u64 = 30_000;

pub const CONFIG_PATH: &str = "/etc/sandbox/config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceConfig {
    pub port: Option<u16>,
    pub command: Option<String>,
    pub workdir: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevForwarderConfig {
    pub public_port: u16,
    pub app_port: u16,
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
    #[serde(default)]
    pub dev_forwarder: Option<DevForwarderConfig>,
}

pub static SANDBOX_CONFIG: LazyLock<RwLock<Option<SandboxConfig>>> = LazyLock::new(|| {
    let config = std::fs::read_to_string(CONFIG_PATH)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok());
    RwLock::new(config)
});

pub fn get_config() -> Option<SandboxConfig> {
    SANDBOX_CONFIG.read().ok().and_then(|g| g.clone())
}
