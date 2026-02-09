use std::sync::LazyLock;

use tokio::sync::Semaphore;

pub const MAX_REQUEST_BODY_BYTES: usize = 15 * 1024 * 1024;
pub const MAX_COMMAND_OUTPUT_BYTES: usize = 15 * 1024 * 1024;

// Keep these conservative. Vsock clients may spike (pollers, batch ops).
pub const MAX_CONCURRENT_EXEC: usize = 8;
pub const MAX_CONCURRENT_GIT: usize = 4;
pub const MAX_CONCURRENT_FILES: usize = 4;

pub static EXEC_SEMAPHORE: LazyLock<Semaphore> =
    LazyLock::new(|| Semaphore::new(MAX_CONCURRENT_EXEC));
pub static GIT_SEMAPHORE: LazyLock<Semaphore> =
    LazyLock::new(|| Semaphore::new(MAX_CONCURRENT_GIT));
pub static FILES_SEMAPHORE: LazyLock<Semaphore> =
    LazyLock::new(|| Semaphore::new(MAX_CONCURRENT_FILES));
