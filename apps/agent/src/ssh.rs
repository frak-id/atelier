//! `GET /ssh/host-keys` — returns the sshd host public key line(s)
//! (`/etc/ssh/ssh_host_*_key.pub`) so the runtime can pin them into the
//! sshpiper `Pipe`'s `known_hosts_data` / the in-server proxy's host
//! verifier instead of trusting the upstream blindly.
//!
//! Sandboxes no longer bake host keys into the image (dropped `ssh-keygen
//! -A` from the Dockerfile): `sandbox-boot.sh` now runs it fresh on every
//! boot, before starting this agent, so the keys already exist by the time
//! this endpoint is reachable. The agent's HTTP control plane is the
//! trusted, already-authenticated channel the runtime dials (not a raw SSH
//! TOFU) — serving the PUBLIC key half here is sound key distribution.

use std::fs;
use std::path::Path;

const SSH_DIR: &str = "/etc/ssh";

/// The sshd host public key lines (one per algorithm `ssh-keygen -A`
/// produced — ed25519/rsa/ecdsa), sorted by filename for a deterministic
/// order. Empty when `/etc/ssh` has no host keys yet (fresh container,
/// sshd/keygen hasn't run) — callers treat an empty result the same as a
/// 404 from an old agent image: fall back to unpinned SSH.
pub fn host_keys() -> Vec<String> {
    host_keys_in(SSH_DIR)
}

fn host_keys_in(dir: &str) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|name| name.starts_with("ssh_host_") && name.ends_with("_key.pub"))
        .collect();
    names.sort();
    names
        .into_iter()
        .filter_map(|name| fs::read_to_string(Path::new(dir).join(name)).ok())
        .map(|content| content.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Isolated per-test scratch dir under the OS temp dir — `read_dir`
    /// ordering isn't guaranteed, so this also exercises the sort.
    fn scratch_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "atelier-ssh-test-{name}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn reads_pub_files_sorted_and_skips_private_keys() {
        let dir = scratch_dir("sorted");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("ssh_host_rsa_key.pub"), "ssh-rsa AAAA rsa\n").unwrap();
        fs::write(
            dir.join("ssh_host_ed25519_key.pub"),
            "ssh-ed25519 AAAA ed\n",
        )
        .unwrap();
        // Private half must never be read/returned.
        fs::write(dir.join("ssh_host_rsa_key"), "-----BEGIN PRIVATE KEY-----").unwrap();

        let keys = host_keys_in(dir.to_str().unwrap());
        assert_eq!(keys, vec!["ssh-ed25519 AAAA ed", "ssh-rsa AAAA rsa"]);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_dir_returns_empty() {
        assert!(host_keys_in("/nonexistent/atelier-ssh-host-keys-test").is_empty());
    }

    #[test]
    fn empty_dir_returns_empty() {
        let dir = scratch_dir("empty");
        fs::create_dir_all(&dir).unwrap();
        assert!(host_keys_in(dir.to_str().unwrap()).is_empty());
        fs::remove_dir_all(&dir).ok();
    }
}
