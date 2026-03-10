use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::Duration;

use crate::config::{SandboxConfig, CONFIG_PATH};

const SSH_DIR: &str = "/home/dev/.ssh";
const AUTHORIZED_KEYS_PATH: &str = "/home/dev/.ssh/authorized_keys";
const DEV_UID: u32 = 1000;
const DEV_GID: u32 = 1000;

const CONFIG_RETRY_ATTEMPTS: u32 = 10;
const CONFIG_RETRY_DELAY: Duration = Duration::from_secs(3);
const SSHD_RESTART_DELAY: Duration = Duration::from_secs(3);

fn chown(path: &str, uid: u32, gid: u32) {
    unsafe {
        let c_path = std::ffi::CString::new(path).unwrap();
        libc::chown(c_path.as_ptr(), uid, gid);
    }
}

/// Read config directly from file with retries.
/// Does NOT use the LazyLock SANDBOX_CONFIG — K8s ConfigMap
/// mounts may not be ready the instant the agent starts.
fn read_config_with_retry() -> Option<SandboxConfig> {
    for attempt in 1..=CONFIG_RETRY_ATTEMPTS {
        match fs::read_to_string(CONFIG_PATH) {
            Ok(contents) => match serde_json::from_str(&contents) {
                Ok(config) => return Some(config),
                Err(e) => {
                    eprintln!(
                        "ssh: config parse error (attempt {attempt}/\
                         {CONFIG_RETRY_ATTEMPTS}): {e}"
                    );
                }
            },
            Err(e) => {
                if attempt < CONFIG_RETRY_ATTEMPTS {
                    eprintln!(
                        "ssh: config not available (attempt {attempt}/\
                         {CONFIG_RETRY_ATTEMPTS}): {e}"
                    );
                } else {
                    eprintln!(
                        "ssh: config not available after \
                         {CONFIG_RETRY_ATTEMPTS} attempts, giving up"
                    );
                    return None;
                }
            }
        }
        thread::sleep(CONFIG_RETRY_DELAY);
    }
    None
}

fn setup_authorized_keys(config: &SandboxConfig) -> bool {
    if let Err(e) = fs::create_dir_all(SSH_DIR) {
        eprintln!("ssh: failed to create {SSH_DIR}: {e}");
        return false;
    }
    fs::set_permissions(SSH_DIR, fs::Permissions::from_mode(0o700)).ok();
    chown(SSH_DIR, DEV_UID, DEV_GID);

    let keys_content = config
        .ssh_authorized_keys
        .iter()
        .map(|k| k.trim())
        .collect::<Vec<_>>()
        .join("\n");

    if let Err(e) = fs::write(AUTHORIZED_KEYS_PATH, format!("{keys_content}\n")) {
        eprintln!("ssh: failed to write authorized_keys: {e}");
        return false;
    }
    fs::set_permissions(AUTHORIZED_KEYS_PATH, fs::Permissions::from_mode(0o600)).ok();
    chown(AUTHORIZED_KEYS_PATH, DEV_UID, DEV_GID);
    true
}

fn ensure_host_keys() -> bool {
    if !Path::new("/etc/ssh/ssh_host_ed25519_key").exists() {
        match Command::new("ssh-keygen").args(["-A"]).status() {
            Ok(s) if s.success() => true,
            Ok(s) => {
                eprintln!("ssh: ssh-keygen -A exited with status {s}");
                false
            }
            Err(e) => {
                eprintln!("ssh: failed to generate host keys: {e}");
                false
            }
        }
    } else {
        true
    }
}

fn supervise_sshd() {
    loop {
        println!("ssh: starting sshd");
        match Command::new("/usr/sbin/sshd").args(["-D", "-e"]).status() {
            Ok(status) => {
                eprintln!(
                    "ssh: sshd exited with status {status}, \
                     restarting in {}s",
                    SSHD_RESTART_DELAY.as_secs()
                );
            }
            Err(e) => {
                eprintln!(
                    "ssh: failed to start sshd: {e}, \
                     retrying in {}s",
                    SSHD_RESTART_DELAY.as_secs()
                );
            }
        }
        thread::sleep(SSHD_RESTART_DELAY);
    }
}

pub fn setup_ssh() {
    let config = match read_config_with_retry() {
        Some(c) => c,
        None => return,
    };

    if config.ssh_authorized_keys.is_empty() {
        return;
    }

    if !setup_authorized_keys(&config) {
        return;
    }

    if !ensure_host_keys() {
        return;
    }

    supervise_sshd();
}
