//! Concurrency + size caps for the exec/files request surface, so a burst of
//! calls can't exhaust fds or memory. Ported from apps/agent-rust limits.rs.

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
