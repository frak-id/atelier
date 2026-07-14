//! `POST /files/write` — write `files[]` to their paths with mode/owner. The
//! runtime calls this before the process phase (file contents never persist in
//! the pushed config) and again on `PATCH /files` for live rotation.

use std::fs::{self, Permissions};
use std::os::unix::fs::{PermissionsExt, chown};
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteFilesRequest {
    pub files: Vec<FileWrite>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileWrite {
    pub path: String,
    pub content: String,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub owner: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWriteResult {
    pub path: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn uid_gid(owner: &str) -> Option<(u32, u32)> {
    match owner {
        "dev" => Some((1000, 1000)),
        "root" => Some((0, 0)),
        _ => None,
    }
}

fn write_one(file: &FileWrite) -> Result<(), String> {
    let path = Path::new(&file.path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create parent dir: {e}"))?;
    }
    fs::write(path, &file.content).map_err(|e| format!("write file: {e}"))?;
    if let Some(mode_str) = &file.mode {
        let mode = u32::from_str_radix(mode_str, 8).map_err(|_| format!("bad mode: {mode_str}"))?;
        fs::set_permissions(path, Permissions::from_mode(mode))
            .map_err(|e| format!("set mode: {e}"))?;
    }
    if let Some(owner) = &file.owner {
        let (uid, gid) = uid_gid(owner).ok_or_else(|| format!("unknown owner: {owner}"))?;
        chown(path, Some(uid), Some(gid)).map_err(|e| format!("chown: {e}"))?;
    }
    Ok(())
}

/// Write every file, collecting a per-file result (partial success is
/// reported, not fatal). Runs the blocking fs work off the async runtime.
pub async fn write_files(req: WriteFilesRequest) -> Vec<FileWriteResult> {
    tokio::task::spawn_blocking(move || {
        req.files
            .iter()
            .map(|file| match write_one(file) {
                Ok(()) => FileWriteResult {
                    path: file.path.clone(),
                    success: true,
                    error: None,
                },
                Err(e) => FileWriteResult {
                    path: file.path.clone(),
                    success: false,
                    error: Some(e),
                },
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}
