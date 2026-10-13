//! Network bytes from the interface counters (`/proc/net/dev`): received
//! and sent, loopback left out. The agent's control traffic (the server
//! polling `/activity`, a console tab's terminal or logs) is subtracted from
//! the payload bytes the agent counted on its own ports (`control.rs`);
//! their TCP/IP headers remain.

use super::NetDelta;

/// Interface byte counters, minus loopback: (received, sent).
pub fn parse_proc_net_dev(text: &str) -> Option<(u64, u64)> {
    let mut received = 0u64;
    let mut sent = 0u64;
    let mut seen = false;
    // Two header lines, then `  name: rx_bytes rx_packets … tx_bytes …`
    // (receive: 8 fields, transmit: 8 fields).
    for line in text.lines().skip(2) {
        let Some((name, counters)) = line.split_once(':') else {
            continue;
        };
        if name.trim() == "lo" {
            continue;
        }
        let fields: Vec<u64> = counters
            .split_whitespace()
            .filter_map(|f| f.parse().ok())
            .collect();
        let (Some(rx), Some(tx)) = (fields.first(), fields.get(8)) else {
            continue;
        };
        received = received.saturating_add(*rx);
        sent = sent.saturating_add(*tx);
        seen = true;
    }
    seen.then_some((received, sent))
}

#[cfg(target_os = "linux")]
pub fn read() -> Option<(u64, u64)> {
    parse_proc_net_dev(&std::fs::read_to_string("/proc/net/dev").ok()?)
}

#[cfg(not(target_os = "linux"))]
pub fn read() -> Option<(u64, u64)> {
    None
}

/// One direction's bookkeeping.
#[derive(Default)]
struct Direction {
    interface: u64,
    control: u64,
    /// Control bytes the interface hasn't shown yet: the agent counts a
    /// write when the kernel takes it, which can be after the sample that
    /// sees it on the wire (or before, for reads). Carried one sample, so
    /// a large control response straddling a sample boundary isn't counted
    /// as the sandbox's traffic.
    unmatched: u64,
}

impl Direction {
    /// Sandbox bytes since the last sample.
    fn advance(&mut self, interface: u64, control: u64) -> u64 {
        // A counter that went down (interface re-created) restarts from 0.
        let moved = interface.saturating_sub(self.interface);
        let control_moved = control.saturating_sub(self.control);
        self.interface = interface;
        self.control = control;
        let credit = self.unmatched + control_moved;
        let matched = credit.min(moved);
        // What this sample's control traffic didn't match carries over;
        // older leftovers are dropped.
        self.unmatched = (credit - matched).min(control_moved);
        moved - matched
    }
}

#[derive(Default)]
pub struct NetdevSampler {
    received: Direction,
    sent: Direction,
    baseline_taken: bool,
}

impl NetdevSampler {
    /// `interface`: [`read`]'s counters; `control`: `control::totals()`.
    /// The first call only takes a baseline (boot traffic isn't activity).
    pub fn account(&mut self, interface: (u64, u64), control: (u64, u64)) -> NetDelta {
        let received = self.received.advance(interface.0, control.0);
        let sent = self.sent.advance(interface.1, control.1);
        if !self.baseline_taken {
            self.baseline_taken = true;
            self.received.unmatched = 0;
            self.sent.unmatched = 0;
            return NetDelta::default();
        }
        NetDelta { received, sent }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROC_NET_DEV: &str = "\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  170524    2959    0    0    0     0          0         0   170524    2959    0    0    0     0       0          0
  eth0: 789327519   33834    0    0    0     0          0         0  4669523   24342    0    0    0     0       0          0
  eth1:1000 3 0 0 0 0 0 0 20 1 0 0 0 0 0 0
";

    #[test]
    fn sums_interfaces_but_loopback() {
        assert_eq!(
            parse_proc_net_dev(PROC_NET_DEV),
            Some((789_327_519 + 1000, 4_669_523 + 20)),
        );
        assert_eq!(parse_proc_net_dev("header\nheader\n"), None);
    }

    #[test]
    fn first_sample_is_a_baseline() {
        let mut s = NetdevSampler::default();
        let d = s.account((5_000_000, 9_000_000), (0, 0));
        assert_eq!((d.received, d.sent), (0, 0));
        let d = s.account((5_100_000, 9_000_300), (0, 0));
        assert_eq!((d.received, d.sent), (100_000, 300));
    }

    #[test]
    fn subtracts_control_traffic() {
        let mut s = NetdevSampler::default();
        s.account((1000, 1000), (50, 50));
        // 70 KB sent, 60 KB of it the agent's own responses.
        let d = s.account((1500, 71_000), (450, 60_050));
        assert_eq!((d.received, d.sent), (100, 10_000));
    }

    #[test]
    fn carries_control_bytes_one_sample() {
        let mut s = NetdevSampler::default();
        s.account((0, 0), (0, 0));
        // A 200 KB control response counted as written, mostly not yet on
        // the wire.
        let d = s.account((0, 50_000), (0, 200_000));
        assert_eq!(d.sent, 0);
        // The rest leaves in the next sample: still the agent's.
        let d = s.account((0, 200_000), (0, 200_000));
        assert_eq!(d.sent, 0);
        let d = s.account((0, 300_000), (0, 200_000));
        assert_eq!(d.sent, 100_000);
    }

    #[test]
    fn unmatched_control_bytes_expire() {
        let mut s = NetdevSampler::default();
        s.account((0, 0), (0, 0));
        // 200 KB counted, 50 KB seen; 150 KB carried.
        s.account((0, 50_000), (0, 200_000));
        // Only 100 KB more on the wire: the last 50 KB of credit expires.
        assert_eq!(s.account((0, 150_000), (0, 200_000)).sent, 0);
        // So the next sample's traffic counts in full.
        assert_eq!(s.account((0, 250_000), (0, 200_000)).sent, 100_000);
    }

    #[test]
    fn counter_reset_is_not_traffic() {
        let mut s = NetdevSampler::default();
        s.account((10_000, 10_000), (0, 0));
        let d = s.account((100, 200), (0, 0));
        assert_eq!((d.received, d.sent), (0, 0));
        let d = s.account((1100, 200), (0, 0));
        assert_eq!(d.received, 1000);
    }
}
