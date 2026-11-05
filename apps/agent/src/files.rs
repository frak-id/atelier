//! `POST /files/write` — write `files[]` to their paths with mode/owner. The
//! runtime calls this before the process phase (file contents never persist in
//! the pushed config) and again for live file patches / credential rotation.
//!
//! Files carry resolved secrets, so each one is written to a temp file in its
//! own directory that is created with its final mode and owner *before* any
//! content lands, then renamed into place: never briefly world-readable, never
//! half-written.

use std::fs::{self, OpenOptions, Permissions};
use std::io::{self, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt, chown, fchown};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

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

/// Create the missing ancestors of `dir`, each owned by `owner` when one is
/// declared (a plain `create_dir_all` would leave them root-owned and
/// unwritable for `dev`).
fn create_parents(dir: &Path, owner: Option<(u32, u32)>) -> io::Result<()> {
    let mut missing = Vec::new();
    let mut cur = Some(dir);
    while let Some(p) = cur {
        if p.as_os_str().is_empty() || p.exists() {
            break;
        }
        missing.push(p);
        cur = p.parent();
    }
    for p in missing.into_iter().rev() {
        match fs::create_dir(p) {
            Ok(()) => {
                if let Some((uid, gid)) = owner {
                    chown(p, Some(uid), Some(gid))?;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Write `content` to a fresh sibling temp file with its final mode/owner set
/// before the content is written; returns the temp path.
fn write_temp(
    dir: &Path,
    name: &str,
    content: &[u8],
    mode: u32,
    owner: Option<(u32, u32)>,
) -> io::Result<std::path::PathBuf> {
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(".{name}.atelier-{}-{n}", std::process::id()));
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&tmp)?;
    let result = (|| {
        // `mode` above is subject to the umask; fchmod makes it exact.
        f.set_permissions(Permissions::from_mode(mode))?;
        if let Some((uid, gid)) = owner {
            fchown(&f, Some(uid), Some(gid))?;
        }
        f.write_all(content)
    })();
    if let Err(e) = result {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(tmp)
}

fn write_one(file: &FileWrite) -> Result<(), String> {
    let path = Path::new(&file.path);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("bad path: {}", file.path))?;
    // Validate everything before touching the filesystem.
    let declared_mode = file
        .mode
        .as_deref()
        .map(|m| u32::from_str_radix(m, 8).map_err(|_| format!("bad mode: {m}")))
        .transpose()?;
    let declared_owner = file
        .owner
        .as_deref()
        .map(|o| uid_gid(o).ok_or_else(|| format!("unknown owner: {o}")))
        .transpose()?;

    // Undeclared mode/owner keep an existing file's, else 0644 / the agent's.
    let existing = fs::metadata(path).ok();
    let mode = declared_mode
        .or_else(|| existing.as_ref().map(|m| m.mode() & 0o7777))
        .unwrap_or(0o644);
    let owner = declared_owner.or_else(|| existing.as_ref().map(|m| (m.uid(), m.gid())));

    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    create_parents(dir, declared_owner).map_err(|e| format!("create parent dir: {e}"))?;
    let tmp = write_temp(dir, name, file.content.as_bytes(), mode, owner)
        .map_err(|e| format!("write file: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename into place: {e}")
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("atelier-files-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn file(path: &Path, content: &str, mode: Option<&str>, owner: Option<&str>) -> FileWrite {
        FileWrite {
            path: path.to_string_lossy().into_owned(),
            content: content.into(),
            mode: mode.map(Into::into),
            owner: owner.map(Into::into),
        }
    }

    fn mode_of(path: &Path) -> u32 {
        fs::metadata(path).unwrap().mode() & 0o7777
    }

    fn leftovers(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".atelier-"))
            .collect()
    }

    #[test]
    fn writes_with_the_declared_mode_exactly() {
        let dir = scratch("mode");
        let secret = dir.join("secret");
        write_one(&file(&secret, "s3cret", Some("600"), None)).unwrap();
        assert_eq!(fs::read_to_string(&secret).unwrap(), "s3cret");
        assert_eq!(mode_of(&secret), 0o600);

        // fchmod, not the umask-filtered create mode, decides the final bits.
        let open = dir.join("open");
        write_one(&file(&open, "x", Some("666"), None)).unwrap();
        assert_eq!(mode_of(&open), 0o666);
        assert!(leftovers(&dir).is_empty(), "temp files must not linger");
    }

    #[test]
    fn temp_file_is_created_with_the_final_mode() {
        let dir = scratch("tmp-mode");
        let tmp = write_temp(&dir, "k", b"secret", 0o600, None).unwrap();
        // Before the rename the temp file already has the final mode.
        assert_eq!(mode_of(&tmp), 0o600);
        assert_eq!(fs::read(&tmp).unwrap(), b"secret");
    }

    #[test]
    fn overwrite_replaces_content_and_keeps_the_existing_mode() {
        let dir = scratch("overwrite");
        let path = dir.join("f");
        write_one(&file(&path, "one", Some("640"), None)).unwrap();
        write_one(&file(&path, "two", None, None)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "two");
        assert_eq!(mode_of(&path), 0o640);
        assert!(leftovers(&dir).is_empty());
    }

    #[test]
    fn creates_missing_parents() {
        let dir = scratch("parents");
        let path = dir.join("a/b/c/f");
        write_one(&file(&path, "x", None, None)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "x");
    }

    #[test]
    fn parents_and_file_take_the_declared_owner() {
        // chown to another uid needs root; skipped elsewhere (dev laptops, CI).
        // SAFETY: geteuid has no preconditions.
        if unsafe { libc::geteuid() } != 0 {
            return;
        }
        let dir = scratch("owner");
        let path = dir.join(".config/x/y/f");
        write_one(&file(&path, "x", Some("600"), Some("dev"))).unwrap();
        for p in [
            dir.join(".config"),
            dir.join(".config/x"),
            dir.join(".config/x/y"),
            path,
        ] {
            let m = fs::metadata(&p).unwrap();
            assert_eq!((m.uid(), m.gid()), (1000, 1000), "{}", p.display());
        }
        // Pre-existing ancestors are left alone.
        assert_eq!(fs::metadata(&dir).unwrap().uid(), 0);
    }

    #[test]
    fn rejects_bad_input_before_touching_the_filesystem() {
        let dir = scratch("invalid");
        let path = dir.join("new/f");
        assert!(
            write_one(&file(&path, "x", Some("zzz"), None))
                .unwrap_err()
                .contains("bad mode")
        );
        assert!(
            write_one(&file(&path, "x", None, Some("nobody")))
                .unwrap_err()
                .contains("unknown owner")
        );
        assert!(
            !dir.join("new").exists(),
            "no parent dir for a rejected write"
        );
    }

    #[tokio::test]
    async fn partial_failure_is_reported_per_file() {
        let dir = scratch("partial");
        let ok = dir.join("ok");
        let req = WriteFilesRequest {
            files: vec![
                file(&ok, "fine", None, None),
                file(&dir.join("bad"), "x", Some("nope"), None),
            ],
        };
        let results = write_files(req).await;
        assert!(results[0].success);
        assert!(!results[1].success);
        assert!(results[1].error.is_some());
    }
}
