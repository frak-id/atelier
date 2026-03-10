use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

use crate::config::get_config;

const SSH_DIR: &str = "/home/dev/.ssh";
const AUTHORIZED_KEYS_PATH: &str = "/home/dev/.ssh/authorized_keys";
const DEV_UID: u32 = 1000;
const DEV_GID: u32 = 1000;

fn chown(path: &str, uid: u32, gid: u32) {
    unsafe {
        let c_path = std::ffi::CString::new(path).unwrap();
        libc::chown(c_path.as_ptr(), uid, gid);
    }
}

pub fn setup_ssh() {
    let config = match get_config() {
        Some(c) => c,
        None => return,
    };

    if config.ssh_authorized_keys.is_empty() {
        return;
    }

    if let Err(e) = fs::create_dir_all(SSH_DIR) {
        eprintln!("ssh: failed to create {SSH_DIR}: {e}");
        return;
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
        return;
    }
    fs::set_permissions(AUTHORIZED_KEYS_PATH, fs::Permissions::from_mode(0o600)).ok();
    chown(AUTHORIZED_KEYS_PATH, DEV_UID, DEV_GID);

    if !Path::new("/etc/ssh/ssh_host_ed25519_key").exists() {
        let status = Command::new("ssh-keygen").args(["-A"]).status();
        if let Err(e) = status {
            eprintln!("ssh: failed to generate host keys: {e}");
            return;
        }
    }

    match Command::new("/usr/sbin/sshd").arg("-e").spawn() {
        Ok(_) => println!("ssh: sshd started"),
        Err(e) => eprintln!("ssh: failed to start sshd: {e}"),
    }
}
