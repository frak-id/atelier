//! Shared plumbing for the attach bridge (attach.rs): a bounded output replay
//! buffer and the tiny WS-handshake request-target parse. Ported from v1
//! apps/agent-rust bridge.rs; the two v1 bridges (acp stdio + terminal PTY)
//! collapse into one attach mechanism here, so the buffer lives once.

use std::collections::VecDeque;

use hyper::body::Bytes;

const BUFFER_LIMIT: usize = 1024 * 1024 * 2;

/// Bounded ring buffer of recent process output, replayed in full to any new
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

/// Attach target parsed from the WS upgrade request line
/// (`GET /{name}?mode=rw&takeover=1 HTTP/1.1`): process name + write intent.
pub struct AttachTarget {
    pub name: String,
    pub writer: bool,
    pub takeover: bool,
}

/// Parse the raw first line of a WS upgrade request. No full HTTP parse — just
/// the request target and its `mode`/`takeover` query params. `mode=rw` asks
/// for the single writer slot; anything else (or absent) is read-only.
pub fn parse_attach_target(buf: &[u8]) -> Option<AttachTarget> {
    let request = String::from_utf8_lossy(buf);
    let target = request.lines().next()?.split_whitespace().nth(1)?;
    let path = target.strip_prefix('/')?;
    let (name, query) = match path.split_once('?') {
        Some((n, q)) => (n, q),
        None => (path, ""),
    };
    if name.is_empty() || name.contains('/') {
        return None;
    }
    let mut writer = false;
    let mut takeover = false;
    for pair in query.split('&') {
        match pair.split_once('=') {
            Some(("mode", "rw")) => writer = true,
            Some(("takeover", "1" | "true")) => takeover = true,
            _ => {}
        }
    }
    Some(AttachTarget {
        name: name.to_string(),
        writer,
        takeover,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffer_trims_to_limit() {
        let mut b = OutputBuffer::default();
        b.push(Bytes::from(vec![b'x'; BUFFER_LIMIT]));
        b.push(Bytes::from(vec![b'y'; 100]));
        let total: usize = b.snapshot_chunks().iter().map(|c| c.len()).sum();
        assert!(total <= BUFFER_LIMIT);
        // The newest bytes survive; the oldest are trimmed.
        let last = b.snapshot_chunks().pop().unwrap();
        assert_eq!(&last[..], &[b'y'; 100]);
    }

    #[test]
    fn parses_rw_and_takeover() {
        let req = b"GET /acp?mode=rw&takeover=1 HTTP/1.1\r\n";
        let t = parse_attach_target(req).unwrap();
        assert_eq!(t.name, "acp");
        assert!(t.writer);
        assert!(t.takeover);
    }

    #[test]
    fn defaults_to_readonly() {
        let t = parse_attach_target(b"GET /web HTTP/1.1\r\n").unwrap();
        assert_eq!(t.name, "web");
        assert!(!t.writer);
        assert!(!t.takeover);
        // mode=ro is explicit read-only.
        assert!(
            !parse_attach_target(b"GET /web?mode=ro HTTP/1.1\r\n")
                .unwrap()
                .writer
        );
    }

    #[test]
    fn rejects_bad_targets() {
        assert!(parse_attach_target(b"GET / HTTP/1.1\r\n").is_none());
        assert!(parse_attach_target(b"GET /a/b HTTP/1.1\r\n").is_none());
    }
}
