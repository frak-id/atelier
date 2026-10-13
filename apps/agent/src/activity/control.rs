//! Bytes the agent itself moves on its control ports (9998 config/process
//! API, 9997 attach bridge, 7681 terminal relay): the server's traffic,
//! never the sandbox's activity. The sock_diag sampler skips those ports by
//! number; the interface-counter fallback (`netdev.rs`, for guest kernels
//! without `inet_diag`) can't, so it subtracts these totals instead.
//!
//! Payload bytes, counted as the agent reads and writes them: the TCP/IP
//! headers of control traffic (~66 B a packet) stay in the interface
//! counters, a few KB a minute with a console tab open.

use std::io::{self, IoSlice};
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

static RECEIVED: AtomicU64 = AtomicU64::new(0);
static SENT: AtomicU64 = AtomicU64::new(0);

/// Control bytes (received, sent) since the agent started.
pub fn totals() -> (u64, u64) {
    (
        RECEIVED.load(Ordering::Relaxed),
        SENT.load(Ordering::Relaxed),
    )
}

/// A connection accepted on a control port, its bytes added to [`totals`].
pub struct Counted<S>(S);

impl<S> Counted<S> {
    pub fn new(inner: S) -> Self {
        Self(inner)
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Counted<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let poll = Pin::new(&mut self.get_mut().0).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = poll {
            let read = buf.filled().len().saturating_sub(before);
            RECEIVED.fetch_add(read as u64, Ordering::Relaxed);
        }
        poll
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Counted<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        count_sent(Pin::new(&mut self.get_mut().0).poll_write(cx, buf))
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        count_sent(Pin::new(&mut self.get_mut().0).poll_write_vectored(cx, bufs))
    }

    fn is_write_vectored(&self) -> bool {
        self.0.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_shutdown(cx)
    }
}

fn count_sent(poll: Poll<io::Result<usize>>) -> Poll<io::Result<usize>> {
    if let Poll::Ready(Ok(n)) = poll {
        SENT.fetch_add(n as u64, Ordering::Relaxed);
    }
    poll
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn counts_both_directions() {
        let (a, mut b) = tokio::io::duplex(1024);
        let mut counted = Counted::new(a);
        // Other tests may count concurrently (the totals are global): only
        // a lower bound holds.
        let (rx0, tx0) = totals();
        counted.write_all(b"hello agent").await.unwrap();
        let mut got = [0u8; 11];
        b.read_exact(&mut got).await.unwrap();
        b.write_all(b"pong").await.unwrap();
        let mut back = [0u8; 4];
        counted.read_exact(&mut back).await.unwrap();
        let (rx1, tx1) = totals();
        assert!(tx1 - tx0 >= 11);
        assert!(rx1 - rx0 >= 4);
    }
}
