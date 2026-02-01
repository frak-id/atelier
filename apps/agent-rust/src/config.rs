use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

pub const VSOCK_PORT: u32 = 9998;
pub const LOG_DIR: &str = "/var/log/sandbox";
pub const WORKSPACE_DIR: &str = "/home/dev/workspace";
pub const DEFAULT_EXEC_TIMEOUT_MS: u64 = 30_000;
pub const MAX_EXEC_BUFFER: usize = 10 * 1024 * 1024;

pub const CONFIG_PATH: &str = "/etc/sandbox/config.json";
pub const VSCODE_SETTINGS_PATH: &str = "/home/dev/.local/share/code-server/User/settings.json";
pub const VSCODE_EXTENSIONS_PATH: &str = "/etc/sandbox/vscode-extensions.json";
pub const OPENCODE_AUTH_PATH: &str = "/home/dev/.local/share/opencode/auth.json";
pub const OPENCODE_CONFIG_PATH: &str = "/home/dev/.config/opencode/opencode.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceConfig {
    pub port: u16,
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
pub struct SandboxServices {
    pub vscode: ServiceConfig,
    pub opencode: ServiceConfig,
    pub terminal: ServiceConfig,
    pub browser: Option<ServiceConfig>,
    pub agent: Option<ServiceConfig>,
}

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

pub static SANDBOX_CONFIG: LazyLock<Option<SandboxConfig>> = LazyLock::new(|| {
    std::fs::read_to_string(CONFIG_PATH)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
});
