//! Shared plumbing for the attach bridge (attach.rs): a bounded output replay
//! buffer and the tiny WS-handshake request-target parse. Process stdio/PTY
//! and terminal sessions share this one attach mechanism, so the buffer lives
//! once.

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
/// (`GET /{name}?mode=rw&takeover=1 HTTP/1.1`): process name + write intent +
/// whether to replay buffered output first.
pub struct AttachTarget {
    pub name: String,
    pub writer: bool,
    pub takeover: bool,
    pub replay: bool,
    /// `/terminal/{id}`: `name` is the terminal session id.
    pub terminal: bool,
}

/// Parse the raw first line of a WS upgrade request. No full HTTP parse — just
/// the request target and its `mode`/`takeover`/`replay` query params.
/// `mode=rw` asks for the single writer slot; anything else (or absent) is
/// read-only. `replay=0` skips the buffered-output replay (default: replay).
///
/// The runtime proxies `WS /v1/sandboxes/:id/attach/:name` straight through, so
/// the target is `/attach/{name}`; a bare `/{name}` is also accepted.
pub fn parse_attach_target(buf: &[u8]) -> Option<AttachTarget> {
    let request = String::from_utf8_lossy(buf);
    let target = request.lines().next()?.split_whitespace().nth(1)?;
    let path = target.strip_prefix('/')?;
    let (path, query) = match path.split_once('?') {
        Some((n, q)) => (n, q),
        None => (path, ""),
    };
    let (terminal, name) = match path.strip_prefix("terminal/") {
        Some(id) => (true, id),
        None => (false, path.strip_prefix("attach/").unwrap_or(path)),
    };
    if name.is_empty() || name.contains('/') {
        return None;
    }
    let mut writer = false;
    let mut takeover = false;
    let mut replay = true;
    for pair in query.split('&') {
        match pair.split_once('=') {
            Some(("mode", "rw")) => writer = true,
            Some(("takeover", "1" | "true")) => takeover = true,
            Some(("replay", "0" | "false")) => replay = false,
            _ => {}
        }
    }
    Some(AttachTarget {
        name: name.to_string(),
        writer,
        takeover,
        replay,
        terminal,
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
    fn accepts_attach_prefix() {
        // The runtime proxies `/attach/:name` straight through.
        let t = parse_attach_target(b"GET /attach/acp?mode=rw HTTP/1.1\r\n").unwrap();
        assert_eq!(t.name, "acp");
        assert!(t.writer);
        let ro = parse_attach_target(b"GET /attach/vscode HTTP/1.1\r\n").unwrap();
        assert_eq!(ro.name, "vscode");
        assert!(!ro.writer);
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
    fn replay_defaults_on_and_opts_out() {
        let t = parse_attach_target(b"GET /acp?mode=rw HTTP/1.1\r\n").unwrap();
        assert!(t.replay);
        let t = parse_attach_target(b"GET /acp?mode=rw&replay=0 HTTP/1.1\r\n").unwrap();
        assert!(!t.replay);
        // Other params (e.g. the auth token) are ignored.
        let t = parse_attach_target(b"GET /acp?token=abc&replay=1 HTTP/1.1\r\n").unwrap();
        assert!(t.replay);
        assert_eq!(t.name, "acp");
    }

    #[test]
    fn parses_terminal_routes() {
        let t = parse_attach_target(b"GET /terminal/term-3?token=x HTTP/1.1\r\n").unwrap();
        assert!(t.terminal);
        assert_eq!(t.name, "term-3");
        assert!(
            !parse_attach_target(b"GET /attach/acp HTTP/1.1\r\n")
                .unwrap()
                .terminal
        );
        assert!(parse_attach_target(b"GET /terminal/ HTTP/1.1\r\n").is_none());
        assert!(parse_attach_target(b"GET /terminal/a/b HTTP/1.1\r\n").is_none());
    }

    #[test]
    fn rejects_bad_targets() {
        assert!(parse_attach_target(b"GET / HTTP/1.1\r\n").is_none());
        assert!(parse_attach_target(b"GET /a/b HTTP/1.1\r\n").is_none());
        // `/attach/` with no name, and a nested name, are both invalid.
        assert!(parse_attach_target(b"GET /attach/ HTTP/1.1\r\n").is_none());
        assert!(parse_attach_target(b"GET /attach/a/b HTTP/1.1\r\n").is_none());
    }
}
