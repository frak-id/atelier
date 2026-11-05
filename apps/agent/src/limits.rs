//! Shared caps and buffer sizes: concurrency + size caps for the exec/files
//! request surface (so a burst of calls can't exhaust fds or memory), and the
//! stream-pump constants the attach bridge, terminals and supervisor share.

use std::sync::LazyLock;

use tokio::sync::Semaphore;

/// Exec/files bodies carry file contents, so the cap is generous (vs the
/// runtime-authored config body, which stays small).
pub const MAX_REQUEST_BODY_BYTES: usize = 15 * 1024 * 1024;

const MAX_CONCURRENT_EXEC: usize = 8;
const MAX_CONCURRENT_FILES: usize = 4;

pub static EXEC_SEMAPHORE: LazyLock<Semaphore> =
    LazyLock::new(|| Semaphore::new(MAX_CONCURRENT_EXEC));
pub static FILES_SEMAPHORE: LazyLock<Semaphore> =
    LazyLock::new(|| Semaphore::new(MAX_CONCURRENT_FILES));

/// Chunk size for reading process/PTY output.
pub const READ_BUFFER_SIZE: usize = 16 * 1024;
/// Live-output fan-out depth per attach endpoint / terminal.
pub const OUTPUT_BROADCAST_CAPACITY: usize = 256;
/// Pending-input depth per attach endpoint / terminal.
pub const WRITE_CHANNEL_CAPACITY: usize = 64;
/// Where per-process and per-terminal logs live (`ATELIER_LOG_DIR` overrides).
pub const DEFAULT_LOG_DIR: &str = "/var/log/sandbox";
