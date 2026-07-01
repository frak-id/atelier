//! Shared helpers for the stdio/PTY <-> WebSocket bridges (terminal + ACP).
//!
//! Both bridges fan child output out to WebSocket clients and replay recent
//! output to late joiners, so the ring buffer and the tiny WS-handshake parsing
//! live here instead of being copied per bridge.

use std::collections::VecDeque;

use hyper::body::Bytes;

const BUFFER_LIMIT: usize = 1024 * 1024 * 2;

/// Bounded ring buffer of recent child output, replayed in full to any new
/// WebSocket client so it catches up before live streaming begins.
#[derive(Default)]
pub struct OutputBuffer {
    chunks: VecDeque<Bytes>,
    total_len: usize,
}

impl OutputBuffer {
    pub fn push(&mut self, chunk: Bytes) {
        if chunk.is_empty() {
            return;
        }
        self.total_len = self.total_len.saturating_add(chunk.len());
        self.chunks.push_back(chunk);
        self.trim_to_limit();
    }

    pub fn snapshot_chunks(&self) -> Vec<Bytes> {
        self.chunks.iter().cloned().collect()
    }

    fn trim_to_limit(&mut self) {
        while self.total_len > BUFFER_LIMIT {
            let excess = self.total_len - BUFFER_LIMIT;
            let Some(front) = self.chunks.pop_front() else {
                self.total_len = 0;
                break;
            };
            if front.len() <= excess {
                self.total_len -= front.len();
                continue;
            }

            // Keep only the tail of the front chunk, slicing without copying.
            let keep = front.slice(excess..);
            self.total_len -= excess;
            self.chunks.push_front(keep);
            break;
        }
    }
}

/// Unique session id with a bridge-specific prefix (e.g. `pty`, `acp`). A
/// process-global atomic counter is appended so concurrent creates in the same
/// nanosecond can't collide. The 8 hex nanos digits after `{prefix}_` keep
/// downstream title slicing stable.
pub fn generate_session_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{nanos:x}_{seq:x}")
}

/// Extract the session id from the raw first line of a WebSocket upgrade
/// request (`GET /<id> HTTP/1.1`). No full HTTP parse — just the request target.
pub fn parse_session_id_from_request(buf: &[u8]) -> Option<String> {
    let request = String::from_utf8_lossy(buf);
    let path = request.lines().next()?.split_whitespace().nth(1)?;
    let id = path.strip_prefix('/')?;
    (!id.is_empty() && !id.contains(' ')).then(|| id.to_string())
}
