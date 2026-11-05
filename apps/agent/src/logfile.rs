//! Size-capped append-only log file. Process and terminal output is teed to
//! `/var/log/sandbox/<name>.log` on the container rootfs; without a cap a
//! chatty dev server fills the disk. Once a log passes `MAX_LOG_BYTES` it is
//! rotated to `<name>.log.1` (replacing any previous `.1`) and a fresh file
//! starts, so at most about twice the cap is kept per name.

use std::io;
use std::sync::Arc;

use tokio::fs::{File, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

pub const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;

pub struct LogFile {
    path: String,
    max_bytes: u64,
    state: Mutex<State>,
}

struct State {
    file: File,
    written: u64,
}

async fn open_append(path: &str) -> io::Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
}

/// Size of an existing regular file (devices such as `/dev/null` never rotate).
async fn regular_file_len(path: &str) -> u64 {
    match tokio::fs::metadata(path).await {
        Ok(m) if m.is_file() => m.len(),
        _ => 0,
    }
}

/// Move the log aside to `<path>.1`. Regular files only: the terminal falls
/// back to `/dev/null` when its log can't open, and that must never be renamed.
async fn rotate(path: &str) {
    if tokio::fs::metadata(path).await.is_ok_and(|m| m.is_file()) {
        let _ = tokio::fs::rename(path, format!("{path}.1")).await;
    }
}

impl LogFile {
    pub async fn open(path: &str) -> io::Result<Arc<Self>> {
        Self::open_capped(path, MAX_LOG_BYTES).await
    }

    async fn open_capped(path: &str, max_bytes: u64) -> io::Result<Arc<Self>> {
        // A restart appends to the previous run's log: rotate it first if it
        // is already over the cap.
        if regular_file_len(path).await > max_bytes {
            rotate(path).await;
        }
        let file = open_append(path).await?;
        let written = regular_file_len(path).await;
        Ok(Arc::new(Self {
            path: path.to_string(),
            max_bytes,
            state: Mutex::new(State { file, written }),
        }))
    }

    /// Append a chunk (best effort: a log write failure never fails the
    /// process it tees), rotating once the cap is passed. Every writer of one
    /// log shares this handle, so a rotation swaps the file under all of them.
    pub async fn append(&self, chunk: &[u8]) {
        let mut state = self.state.lock().await;
        if state.file.write_all(chunk).await.is_err() || state.file.flush().await.is_err() {
            return;
        }
        state.written += chunk.len() as u64;
        if state.written > self.max_bytes {
            rotate(&self.path).await;
            if let Ok(file) = open_append(&self.path).await {
                state.file = file;
            }
            // Reset even if the reopen failed, so a failure retries after
            // another cap's worth of output instead of on every chunk.
            state.written = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> String {
        let dir = std::env::temp_dir().join(format!("atelier-logfile-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name).to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn rotates_once_the_cap_is_passed() {
        let path = temp_path("rotate.log");
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{path}.1"));
        let log = LogFile::open_capped(&path, 100).await.unwrap();
        for _ in 0..3 {
            log.append(&[b'a'; 60]).await;
        }
        // 60, then 120 > 100 rotates, then 60 lands in the fresh file.
        assert_eq!(std::fs::read(format!("{path}.1")).unwrap().len(), 120);
        assert_eq!(std::fs::read(&path).unwrap().len(), 60);
    }

    #[tokio::test]
    async fn rotates_an_oversized_log_on_open() {
        let path = temp_path("open.log");
        let _ = std::fs::remove_file(format!("{path}.1"));
        std::fs::write(&path, [b'x'; 200]).unwrap();
        let log = LogFile::open_capped(&path, 100).await.unwrap();
        log.append(b"hi").await;
        assert_eq!(std::fs::read(format!("{path}.1")).unwrap().len(), 200);
        assert_eq!(std::fs::read(&path).unwrap(), b"hi");
    }

    #[tokio::test]
    async fn never_rotates_a_device() {
        let log = LogFile::open_capped("/dev/null", 1).await.unwrap();
        log.append(&[b'z'; 64]).await;
        assert!(!std::path::Path::new("/dev/null.1").exists());
    }
}
