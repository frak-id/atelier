//! Network bytes per minute, from a `NETLINK_SOCK_DIAG` dump of the TCP
//! sockets with `INET_DIAG_INFO` (`tcp_info`): per-socket deltas of
//! `tcpi_bytes_acked + tcpi_bytes_received`, keyed by socket cookie. Bytes,
//! not connection counts: an idle WebSocket stays ESTABLISHED forever but
//! only trickles heartbeats, which the server's threshold ignores.
//!
//! Skipped: loopback (forwarder hops, process-to-process) and the agent's
//! own ports (the server's control traffic, including the activity poll).
//! A connection is *inbound* when its local port is a listening one,
//! *outbound* otherwise.
//!
//! Per-process attribution (console stats only, never the pause decision):
//! socket inode → pid through `/proc/*/fd`, scanned only when a socket with
//! traffic has no known owner; a pid in a supervised process group is named
//! after the spec's process. Inbound traffic the agent's port forwarder
//! accepted is attributed to the process listening on that port's loopback
//! address — the dev server behind it.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use super::netdev::NetdevSampler;
use super::{NetDelta, Owner, control};

/// The kernel has no sock_diag handler for TCP (`inet_diag` not built):
/// permanent, unlike a timeout.
fn lacks_inet_diag(e: &std::io::Error) -> bool {
    matches!(
        e.raw_os_error(),
        Some(libc::ENOENT | libc::EPROTONOSUPPORT | libc::EAFNOSUPPORT | libc::EOPNOTSUPP)
    )
}

/// The agent's own listeners: control plane, attach bridge, terminal relay.
const AGENT_PORTS: [u16; 3] = [
    crate::AGENT_PORT,
    crate::attach::ATTACH_PORT,
    crate::terminal::TERMINAL_PORT,
];

const TCP_LISTEN: u8 = 10;

// Linux ABI constants (spelled out: the parser is portable, libc's AF_*
// values are not — AF_INET6 is 30 on macOS).
const LINUX_AF_INET: u8 = 2;
const LINUX_AF_INET6: u8 = 10;
const IPPROTO_TCP: u8 = 6;
#[cfg(target_os = "linux")]
const NETLINK_SOCK_DIAG: libc::c_int = 4;
const SOCK_DIAG_BY_FAMILY: u16 = 20;
/// `enum sknetlink_groups`: the TCP destroy broadcast groups.
#[cfg(target_os = "linux")]
const SKNLGRP_INET_TCP_DESTROY: u32 = 1;
#[cfg(target_os = "linux")]
const SKNLGRP_INET6_TCP_DESTROY: u32 = 3;
const NLM_F_REQUEST: u16 = 0x1;
const NLM_F_DUMP: u16 = 0x300;
const NLMSG_ERROR: u16 = 2;
const NLMSG_DONE: u16 = 3;
const NLMSG_HDRLEN: usize = 16;
/// `struct inet_diag_req_v2`.
const INET_DIAG_REQ_LEN: usize = 56;
/// `struct inet_diag_msg`.
const INET_DIAG_MSG_LEN: usize = 72;
const INET_DIAG_INFO: u16 = 2;
/// `struct tcp_info` offsets (stable ABI since Linux 4.2).
const TCPI_BYTES_ACKED: usize = 120;
const TCPI_BYTES_RECEIVED: usize = 128;

/// One TCP socket from a sock_diag dump.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TcpSocket {
    pub cookie: u64,
    pub state: u8,
    pub src: IpAddr,
    pub sport: u16,
    pub dst: IpAddr,
    pub dport: u16,
    pub inode: u32,
    /// `tcpi_bytes_acked + tcpi_bytes_received`, when `tcp_info` came back.
    pub bytes: Option<u64>,
}

/// How socket owners are found (`/proc` in production, a fake in tests).
pub trait Procs {
    /// The pid holding each of these socket inodes, for those found.
    fn socket_owners(&mut self, inodes: &HashSet<u32>) -> HashMap<u32, u32>;
    /// A pid's `comm` and process group.
    fn describe(&self, pid: u32) -> Option<(String, u32)>;
}

pub struct NetSampler {
    /// Cumulative bytes per live socket cookie at the last sample.
    prev: HashMap<u64, u64>,
    /// Sockets that left the last dump before their destroy event came in:
    /// their last count, kept one sample so a late event isn't counted whole.
    gone: HashMap<u64, u64>,
    owners: HashMap<u64, Owner>,
    /// The first dump is only a baseline: sockets older than the agent would
    /// otherwise count their whole history as one minute's traffic.
    baseline_taken: bool,
    available: bool,
    /// Final counters of closed sockets (sock_diag destroy broadcasts), so a
    /// connection shorter than a sample (a git fetch, a one-off request)
    /// still counts.
    destroyed: Option<std::sync::mpsc::Receiver<TcpSocket>>,
    /// Set once the kernel turns out to have no `inet_diag` (Kata's stock
    /// guest kernel): interface counters from then on.
    netdev: Option<NetdevSampler>,
}

impl NetSampler {
    pub fn new() -> Self {
        Self {
            prev: HashMap::new(),
            gone: HashMap::new(),
            owners: HashMap::new(),
            baseline_taken: false,
            available: cfg!(target_os = "linux"),
            destroyed: None,
            netdev: None,
        }
    }

    /// Also listen for closed sockets' final counters (best-effort: without
    /// them, a connection opened and closed between two samples is missed).
    pub fn with_destroy_events(mut self) -> Self {
        self.destroyed = listen_destroyed();
        self
    }

    pub fn status(&self) -> &'static str {
        if self.netdev.is_some() {
            return "netdev";
        }
        match (self.available, self.destroyed.is_some()) {
            (false, _) => "unavailable",
            (true, true) => "sock_diag+destroy",
            (true, false) => "sock_diag",
        }
    }

    /// Dump the sockets and account what moved since the last sample.
    /// `groups`: supervised process group (leader pid) → spec name.
    pub fn sample(&mut self, groups: &HashMap<u32, String>) -> Option<NetDelta> {
        if let Some(netdev) = &mut self.netdev {
            return Some(netdev.account(super::netdev::read()?, control::totals()));
        }
        let closed: Vec<TcpSocket> = self
            .destroyed
            .as_ref()
            .map(|rx| rx.try_iter().collect())
            .unwrap_or_default();
        match dump() {
            Ok(sockets) => {
                self.available = true;
                let me = std::process::id();
                Some(self.account(&sockets, &closed, groups, &mut ProcFs, me))
            }
            Err(e) if lacks_inet_diag(&e) => {
                let interface = super::netdev::read()?;
                eprintln!(
                    "atelier-agent: no sock_diag for TCP ({e}); counting network \
                     bytes from the interface counters"
                );
                // No inet_diag: the destroy broadcasts never fire either.
                self.destroyed = None;
                let mut netdev = NetdevSampler::default();
                let baseline = netdev.account(interface, control::totals());
                self.netdev = Some(netdev);
                Some(baseline)
            }
            Err(e) => {
                if self.available {
                    eprintln!("atelier-agent: sock_diag dump failed: {e}");
                }
                self.available = false;
                None
            }
        }
    }

    fn account(
        &mut self,
        sockets: &[TcpSocket],
        closed: &[TcpSocket],
        groups: &HashMap<u32, String>,
        procs: &mut impl Procs,
        me: u32,
    ) -> NetDelta {
        let mut listening: HashSet<u16> = HashSet::new();
        let mut loopback_listeners: HashMap<u16, Vec<u32>> = HashMap::new();
        for s in sockets.iter().filter(|s| s.state == TCP_LISTEN) {
            listening.insert(s.sport);
            if is_loopback(&s.src) {
                loopback_listeners.entry(s.sport).or_default().push(s.inode);
            }
        }
        // (owner, inbound, bytes moved)
        let mut tallies: Vec<(Owner, bool, u64)> = Vec::new();

        // Closed since the last sample: their final counters, from where the
        // last dump left them. The fd is gone, so only an owner seen before
        // can be named.
        for s in closed {
            let start = self
                .prev
                .remove(&s.cookie)
                .or_else(|| self.gone.remove(&s.cookie));
            let owner = self.owners.remove(&s.cookie);
            let Some(bytes) = s.bytes else { continue };
            if !counts(s) {
                continue;
            }
            let delta = match start {
                Some(prev) => bytes.saturating_sub(prev),
                None if self.baseline_taken => bytes,
                None => 0,
            };
            if delta > 0 {
                let owner = owner.unwrap_or_else(|| Owner {
                    name: "short-lived".into(),
                    supervised: false,
                });
                tallies.push((owner, listening.contains(&s.sport), delta));
            }
        }

        let mut next = HashMap::with_capacity(self.prev.len());
        // (socket, inbound, bytes moved)
        let mut moved: Vec<(&TcpSocket, bool, u64)> = Vec::new();
        for s in sockets.iter().filter(|s| s.state != TCP_LISTEN) {
            let Some(bytes) = s.bytes else { continue };
            next.insert(s.cookie, bytes);
            if !counts(s) {
                continue;
            }
            let delta = match self.prev.get(&s.cookie) {
                Some(&prev) => bytes.saturating_sub(prev),
                None if self.baseline_taken => bytes,
                None => 0,
            };
            if delta > 0 {
                moved.push((s, listening.contains(&s.sport), delta));
            }
        }
        self.gone = self
            .prev
            .drain()
            .filter(|(cookie, _)| !next.contains_key(cookie))
            .collect();
        self.prev = next;
        self.baseline_taken = true;
        self.owners
            .retain(|cookie, _| self.prev.contains_key(cookie) || self.gone.contains_key(cookie));

        self.resolve_owners(&moved, &loopback_listeners, groups, procs, me);
        for (s, inbound, bytes) in moved {
            let owner = self.owners.get(&s.cookie).cloned().unwrap_or_else(unknown);
            tallies.push((owner, inbound, bytes));
        }

        let mut delta = NetDelta::default();
        let mut by_owner: HashMap<Owner, (u64, u64)> = HashMap::new();
        for (owner, inbound, bytes) in tallies {
            let entry = by_owner.entry(owner).or_default();
            if inbound {
                delta.inbound += bytes;
                entry.0 += bytes;
            } else {
                delta.outbound += bytes;
                entry.1 += bytes;
            }
        }
        delta.by_owner = by_owner
            .into_iter()
            .map(|(owner, (inbound, outbound))| (owner, inbound, outbound))
            .collect();
        delta
    }

    /// Name the owner of each socket that moved bytes and has none yet. One
    /// `/proc` scan per sample at most, and only when something is missing.
    fn resolve_owners(
        &mut self,
        moved: &[(&TcpSocket, bool, u64)],
        loopback_listeners: &HashMap<u16, Vec<u32>>,
        groups: &HashMap<u32, String>,
        procs: &mut impl Procs,
        me: u32,
    ) {
        let pending: Vec<&(&TcpSocket, bool, u64)> = moved
            .iter()
            .filter(|(s, ..)| !self.owners.contains_key(&s.cookie))
            .collect();
        if pending.is_empty() {
            return;
        }
        let mut wanted: HashSet<u32> = HashSet::new();
        for (s, inbound, _) in &pending {
            if s.inode != 0 {
                wanted.insert(s.inode);
            }
            if *inbound && let Some(listeners) = loopback_listeners.get(&s.sport) {
                wanted.extend(listeners);
            }
        }
        let pids = procs.socket_owners(&wanted);
        for (s, inbound, _) in pending {
            let mut pid = pids.get(&s.inode).copied();
            if *inbound && pid == Some(me) {
                // The agent's port forwarder accepted it: the dev server it
                // relays to listens on loopback, same port.
                let listener = loopback_listeners
                    .get(&s.sport)
                    .into_iter()
                    .flatten()
                    .filter_map(|inode| pids.get(inode))
                    .find(|&&p| p != me);
                if let Some(&p) = listener {
                    pid = Some(p);
                }
            }
            let owner = pid
                .and_then(|p| owner_of(p, groups, procs, me))
                .unwrap_or_else(unknown);
            self.owners.insert(s.cookie, owner);
        }
    }
}

/// Whether a socket's bytes are sandbox activity: not loopback (forwarder
/// hops, process-to-process), not the agent's own ports (the server's
/// control traffic).
fn counts(s: &TcpSocket) -> bool {
    !(is_loopback(&s.src) || is_loopback(&s.dst) || AGENT_PORTS.contains(&s.sport))
}

fn unknown() -> Owner {
    Owner {
        name: "unknown".into(),
        supervised: false,
    }
}

fn owner_of(pid: u32, groups: &HashMap<u32, String>, procs: &impl Procs, me: u32) -> Option<Owner> {
    if pid == me {
        return Some(Owner {
            name: "atelier-agent".into(),
            supervised: false,
        });
    }
    let (comm, pgid) = procs.describe(pid)?;
    Some(match groups.get(&pgid) {
        Some(name) => Owner {
            name: name.clone(),
            supervised: true,
        },
        None => Owner {
            name: comm,
            supervised: false,
        },
    })
}

fn is_loopback(addr: &IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
    }
}

/// `/proc`-backed owner lookup.
struct ProcFs;

impl Procs for ProcFs {
    fn socket_owners(&mut self, inodes: &HashSet<u32>) -> HashMap<u32, u32> {
        let mut found = HashMap::new();
        if inodes.is_empty() {
            return found;
        }
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return found;
        };
        for entry in entries.flatten() {
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|s| s.parse::<u32>().ok())
            else {
                continue;
            };
            let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
                continue;
            };
            for fd in fds.flatten() {
                let Ok(target) = std::fs::read_link(fd.path()) else {
                    continue;
                };
                if let Some(inode) = target.to_str().and_then(parse_socket_link)
                    && inodes.contains(&inode)
                {
                    found.entry(inode).or_insert(pid);
                    if found.len() == inodes.len() {
                        return found;
                    }
                }
            }
        }
        found
    }

    fn describe(&self, pid: u32) -> Option<(String, u32)> {
        parse_proc_stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
    }
}

/// `socket:[12345]` → 12345.
fn parse_socket_link(link: &str) -> Option<u32> {
    link.strip_prefix("socket:[")?
        .strip_suffix(']')?
        .parse()
        .ok()
}

/// `comm` and `pgrp` from `/proc/<pid>/stat` (`pid (comm) state ppid pgrp …`;
/// `comm` may itself contain spaces and parentheses, hence the last `)`).
fn parse_proc_stat(stat: &str) -> Option<(String, u32)> {
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let comm = stat.get(open + 1..close)?.to_string();
    let pgrp = stat
        .get(close + 1..)?
        .split_whitespace()
        .nth(2)?
        .parse()
        .ok()?;
    Some((comm, pgrp))
}

// ── netlink ──────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn dump() -> std::io::Result<Vec<TcpSocket>> {
    let mut sockets = dump_family(LINUX_AF_INET)?;
    sockets.extend(dump_family(LINUX_AF_INET6)?);
    Ok(sockets)
}

#[cfg(not(target_os = "linux"))]
fn dump() -> std::io::Result<Vec<TcpSocket>> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "sock_diag is Linux-only",
    ))
}

#[cfg(target_os = "linux")]
fn dump_family(family: u8) -> std::io::Result<Vec<TcpSocket>> {
    use std::io::Error;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    // SAFETY: plain socket(2); the fd is owned (closed on drop) right after.
    let raw = unsafe {
        libc::socket(
            libc::AF_NETLINK,
            libc::SOCK_DGRAM | libc::SOCK_CLOEXEC,
            NETLINK_SOCK_DIAG,
        )
    };
    if raw < 0 {
        return Err(Error::last_os_error());
    }
    // SAFETY: `raw` is a fresh, valid fd nobody else owns.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };

    // A kernel that never answers must not wedge the sampler.
    let timeout = libc::timeval {
        tv_sec: 2,
        tv_usec: 0,
    };
    // SAFETY: valid fd, pointer + size of a live timeval.
    unsafe {
        libc::setsockopt(
            fd.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_RCVTIMEO,
            (&timeout as *const libc::timeval).cast(),
            std::mem::size_of::<libc::timeval>() as libc::socklen_t,
        );
    }

    let request = build_request(family, 1);
    // SAFETY: all-zero is a valid sockaddr_nl (pid 0 = the kernel).
    let mut kernel: libc::sockaddr_nl = unsafe { std::mem::zeroed() };
    kernel.nl_family = libc::AF_NETLINK as libc::sa_family_t;
    // SAFETY: valid fd, request buffer and address for the given lengths.
    let sent = unsafe {
        libc::sendto(
            fd.as_raw_fd(),
            request.as_ptr().cast(),
            request.len(),
            0,
            (&kernel as *const libc::sockaddr_nl).cast(),
            std::mem::size_of::<libc::sockaddr_nl>() as libc::socklen_t,
        )
    };
    if sent < 0 {
        return Err(Error::last_os_error());
    }

    let mut buf = vec![0u8; 64 * 1024];
    let mut sockets = Vec::new();
    loop {
        // SAFETY: valid fd; `buf` is writable for its whole length.
        let n = unsafe { libc::recv(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len(), 0) };
        if n < 0 {
            let err = Error::last_os_error();
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
        if n == 0 {
            return Ok(sockets);
        }
        match parse_messages(&buf[..n as usize], &mut sockets) {
            Parsed::More => continue,
            Parsed::Done => return Ok(sockets),
            Parsed::Error(errno) => return Err(Error::from_raw_os_error(errno)),
        }
    }
}

/// Subscribe to the TCP destroy broadcasts (IPv4 + IPv6): the kernel sends
/// each closing socket's final `inet_diag_msg` + `tcp_info`. A reader thread
/// forwards them; the sampler drains the channel each sample.
#[cfg(target_os = "linux")]
fn listen_destroyed() -> Option<std::sync::mpsc::Receiver<TcpSocket>> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

    // SAFETY: plain socket(2); owned right after.
    let raw = unsafe {
        libc::socket(
            libc::AF_NETLINK,
            libc::SOCK_DGRAM | libc::SOCK_CLOEXEC,
            NETLINK_SOCK_DIAG,
        )
    };
    if raw < 0 {
        return None;
    }
    // SAFETY: a fresh fd nobody else owns.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    // SAFETY: all-zero is a valid sockaddr_nl.
    let mut addr: libc::sockaddr_nl = unsafe { std::mem::zeroed() };
    addr.nl_family = libc::AF_NETLINK as libc::sa_family_t;
    addr.nl_groups = (1 << (SKNLGRP_INET_TCP_DESTROY - 1)) | (1 << (SKNLGRP_INET6_TCP_DESTROY - 1));
    // SAFETY: valid fd and address for the given length.
    let bound = unsafe {
        libc::bind(
            fd.as_raw_fd(),
            (&addr as *const libc::sockaddr_nl).cast(),
            std::mem::size_of::<libc::sockaddr_nl>() as libc::socklen_t,
        )
    };
    if bound < 0 {
        eprintln!(
            "atelier-agent: sock_diag destroy events unavailable ({}); short connections may be missed",
            std::io::Error::last_os_error()
        );
        return None;
    }
    // Room for a burst of closes between two drains (best-effort).
    let rcvbuf: libc::c_int = 1 << 20;
    // SAFETY: valid fd, pointer + size of a live c_int.
    unsafe {
        libc::setsockopt(
            fd.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_RCVBUF,
            (&rcvbuf as *const libc::c_int).cast(),
            std::mem::size_of::<libc::c_int>() as libc::socklen_t,
        );
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("activity-net-destroy".into())
        .spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                // SAFETY: valid fd; `buf` is writable for its whole length.
                let n =
                    unsafe { libc::recv(fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len(), 0) };
                if n < 0 {
                    // ENOBUFS: the socket overflowed and events were lost;
                    // keep going with the next ones.
                    match std::io::Error::last_os_error().raw_os_error() {
                        Some(libc::EINTR | libc::ENOBUFS) => continue,
                        _ => return,
                    }
                }
                let mut closed = Vec::new();
                parse_messages(&buf[..n as usize], &mut closed);
                for socket in closed {
                    if tx.send(socket).is_err() {
                        return; // the sampler is gone
                    }
                }
            }
        });
    spawned.ok().map(|_| rx)
}

#[cfg(not(target_os = "linux"))]
fn listen_destroyed() -> Option<std::sync::mpsc::Receiver<TcpSocket>> {
    None
}

/// A `SOCK_DIAG_BY_FAMILY` dump request for every TCP socket of `family`,
/// asking for `tcp_info`.
fn build_request(family: u8, seq: u32) -> Vec<u8> {
    let len = NLMSG_HDRLEN + INET_DIAG_REQ_LEN;
    let mut b = Vec::with_capacity(len);
    // nlmsghdr
    b.extend_from_slice(&(len as u32).to_ne_bytes());
    b.extend_from_slice(&SOCK_DIAG_BY_FAMILY.to_ne_bytes());
    b.extend_from_slice(&(NLM_F_REQUEST | NLM_F_DUMP).to_ne_bytes());
    b.extend_from_slice(&seq.to_ne_bytes());
    b.extend_from_slice(&0u32.to_ne_bytes());
    // inet_diag_req_v2: family, protocol, ext (bit INET_DIAG_INFO - 1), pad
    b.extend_from_slice(&[family, IPPROTO_TCP, 1 << (INET_DIAG_INFO - 1), 0]);
    b.extend_from_slice(&u32::MAX.to_ne_bytes()); // every state
    b.extend_from_slice(&[0u8; 48]); // inet_diag_sockid: match any
    b
}

#[derive(Debug, PartialEq, Eq)]
enum Parsed {
    More,
    Done,
    Error(i32),
}

const fn align4(n: usize) -> usize {
    (n + 3) & !3
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_ne_bytes([b[at], b[at + 1]])
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_ne_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

fn u64_at(b: &[u8], at: usize) -> u64 {
    let mut raw = [0u8; 8];
    raw.copy_from_slice(&b[at..at + 8]);
    u64::from_ne_bytes(raw)
}

/// Walk one `recv` worth of netlink messages, appending the sockets.
fn parse_messages(buf: &[u8], out: &mut Vec<TcpSocket>) -> Parsed {
    let mut off = 0;
    while off + NLMSG_HDRLEN <= buf.len() {
        let len = u32_at(buf, off) as usize;
        if len < NLMSG_HDRLEN || off + len > buf.len() {
            break;
        }
        match u16_at(buf, off + 4) {
            NLMSG_DONE => return Parsed::Done,
            NLMSG_ERROR => {
                // nlmsgerr: a negative errno (0 = an ack).
                let err = if len >= NLMSG_HDRLEN + 4 {
                    i32::from_ne_bytes(u32_at(buf, off + NLMSG_HDRLEN).to_ne_bytes())
                } else {
                    0
                };
                return if err == 0 {
                    Parsed::Done
                } else {
                    Parsed::Error(-err)
                };
            }
            SOCK_DIAG_BY_FAMILY => {
                if let Some(socket) = parse_socket(&buf[off + NLMSG_HDRLEN..off + len]) {
                    out.push(socket);
                }
            }
            _ => {}
        }
        off += align4(len);
    }
    Parsed::More
}

/// One `inet_diag_msg` + its attributes.
fn parse_socket(msg: &[u8]) -> Option<TcpSocket> {
    if msg.len() < INET_DIAG_MSG_LEN {
        return None;
    }
    let family = msg[0];
    let addr = |raw: &[u8]| -> Option<IpAddr> {
        match family {
            LINUX_AF_INET => Some(IpAddr::V4(Ipv4Addr::new(raw[0], raw[1], raw[2], raw[3]))),
            LINUX_AF_INET6 => {
                let mut octets = [0u8; 16];
                octets.copy_from_slice(&raw[..16]);
                Some(IpAddr::V6(Ipv6Addr::from(octets)))
            }
            _ => None,
        }
    };
    let mut bytes = None;
    let mut off = INET_DIAG_MSG_LEN;
    while off + 4 <= msg.len() {
        let rta_len = u16_at(msg, off) as usize;
        if rta_len < 4 || off + rta_len > msg.len() {
            break;
        }
        if u16_at(msg, off + 2) == INET_DIAG_INFO {
            let info = &msg[off + 4..off + rta_len];
            if info.len() >= TCPI_BYTES_RECEIVED + 8 {
                bytes = Some(
                    u64_at(info, TCPI_BYTES_ACKED)
                        .saturating_add(u64_at(info, TCPI_BYTES_RECEIVED)),
                );
            }
        }
        off += align4(rta_len);
    }
    Some(TcpSocket {
        state: msg[1],
        sport: u16::from_be_bytes([msg[4], msg[5]]),
        dport: u16::from_be_bytes([msg[6], msg[7]]),
        src: addr(&msg[8..24])?,
        dst: addr(&msg[24..40])?,
        cookie: u64::from(u32_at(msg, 44)) | (u64::from(u32_at(msg, 48)) << 32),
        inode: u32_at(msg, 68),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const ESTABLISHED: u8 = 1;
    const POD: IpAddr = IpAddr::V4(Ipv4Addr::new(10, 42, 0, 7));
    const PEER: IpAddr = IpAddr::V4(Ipv4Addr::new(10, 42, 0, 1));
    const REMOTE: IpAddr = IpAddr::V4(Ipv4Addr::new(104, 18, 0, 1));
    const LOOP: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
    const ME: u32 = 1;

    fn sock(
        cookie: u64,
        state: u8,
        src: (IpAddr, u16),
        dst: (IpAddr, u16),
        inode: u32,
        bytes: u64,
    ) -> TcpSocket {
        TcpSocket {
            cookie,
            state,
            src: src.0,
            sport: src.1,
            dst: dst.0,
            dport: dst.1,
            inode,
            bytes: Some(bytes),
        }
    }

    /// inode → pid, pid → (comm, pgid).
    struct FakeProcs {
        sockets: HashMap<u32, u32>,
        procs: HashMap<u32, (String, u32)>,
        scans: usize,
    }

    impl Procs for FakeProcs {
        fn socket_owners(&mut self, inodes: &HashSet<u32>) -> HashMap<u32, u32> {
            self.scans += 1;
            inodes
                .iter()
                .filter_map(|i| self.sockets.get(i).map(|p| (*i, *p)))
                .collect()
        }
        fn describe(&self, pid: u32) -> Option<(String, u32)> {
            self.procs.get(&pid).cloned()
        }
    }

    fn procs() -> FakeProcs {
        FakeProcs {
            // 100: code-server's socket; 200: vite's loopback listener;
            // 300: a git child of the acp agent; 400: the forwarder's
            // accepted socket (owned by the agent).
            sockets: HashMap::from([(100, 10), (200, 20), (300, 31), (400, ME)]),
            procs: HashMap::from([
                (10, ("node".into(), 10)),
                (20, ("node".into(), 20)),
                (31, ("git".into(), 30)),
            ]),
            scans: 0,
        }
    }

    fn groups() -> HashMap<u32, String> {
        HashMap::from([(10, "code-server".into()), (30, "acp".into())])
    }

    fn by_name(delta: &NetDelta) -> Vec<(String, bool, u64, u64)> {
        let mut rows: Vec<_> = delta
            .by_owner
            .iter()
            .map(|(o, i, out)| (o.name.clone(), o.supervised, *i, *out))
            .collect();
        rows.sort();
        rows
    }

    #[test]
    fn counts_deltas_by_direction_and_skips_noise() {
        let mut net = NetSampler::new();
        let mut p = procs();
        let listen = |port, ip| {
            sock(
                port as u64,
                TCP_LISTEN,
                (ip, port),
                (IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
                0,
                0,
            )
        };
        let snapshot = |code: u64, git: u64, agent: u64, lo: u64| {
            vec![
                listen(8080, IpAddr::V4(Ipv4Addr::UNSPECIFIED)),
                // inbound to code-server
                sock(1, ESTABLISHED, (POD, 8080), (PEER, 50000), 100, code),
                // outbound git fetch
                sock(2, ESTABLISHED, (POD, 40000), (REMOTE, 443), 300, git),
                // the server polling the agent: never activity
                sock(
                    3,
                    ESTABLISHED,
                    (POD, crate::AGENT_PORT),
                    (PEER, 50001),
                    0,
                    agent,
                ),
                // loopback hop
                sock(4, ESTABLISHED, (LOOP, 41000), (LOOP, 5173), 0, lo),
            ]
        };
        // First dump: a baseline, nothing counted.
        let first = net.account(
            &snapshot(1_000, 5_000, 9_000, 7_000),
            &[],
            &groups(),
            &mut p,
            ME,
        );
        assert_eq!((first.inbound, first.outbound), (0, 0));
        assert_eq!(p.scans, 0);

        let second = net.account(
            &snapshot(1_500, 5_100, 99_000, 70_000),
            &[],
            &groups(),
            &mut p,
            ME,
        );
        assert_eq!((second.inbound, second.outbound), (500, 100));
        assert_eq!(
            by_name(&second),
            vec![
                ("acp".into(), true, 0, 100),
                ("code-server".into(), true, 500, 0)
            ]
        );

        // Owners are cached: no new scan for the same sockets.
        net.account(
            &snapshot(1_600, 5_100, 99_000, 70_000),
            &[],
            &groups(),
            &mut p,
            ME,
        );
        assert_eq!(p.scans, 1);
    }

    #[test]
    fn a_socket_opened_after_the_baseline_counts_whole() {
        let mut net = NetSampler::new();
        let mut p = procs();
        net.account(&[], &[], &groups(), &mut p, ME);
        let d = net.account(
            &[sock(
                9,
                ESTABLISHED,
                (POD, 40000),
                (REMOTE, 443),
                300,
                4_000,
            )],
            &[],
            &groups(),
            &mut p,
            ME,
        );
        assert_eq!(d.outbound, 4_000);
    }

    #[test]
    fn forwarded_inbound_is_attributed_to_the_loopback_listener() {
        let mut net = NetSampler::new();
        let mut p = procs();
        let dump = |bytes| {
            vec![
                // The agent's forwarder listens on the pod IP, vite on loopback.
                sock(
                    50,
                    TCP_LISTEN,
                    (POD, 5173),
                    (IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
                    401,
                    0,
                ),
                sock(
                    51,
                    TCP_LISTEN,
                    (LOOP, 5173),
                    (IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0),
                    200,
                    0,
                ),
                sock(5, ESTABLISHED, (POD, 5173), (PEER, 50100), 400, bytes),
            ]
        };
        net.account(&dump(0), &[], &groups(), &mut p, ME);
        let d = net.account(&dump(2_000), &[], &groups(), &mut p, ME);
        assert_eq!(d.inbound, 2_000);
        assert_eq!(by_name(&d), vec![("node".into(), false, 2_000, 0)]);
    }

    #[test]
    fn closed_sockets_count_their_final_bytes_once() {
        let mut net = NetSampler::new();
        let mut p = procs();
        let fetch = |bytes| sock(2, ESTABLISHED, (POD, 40000), (REMOTE, 443), 300, bytes);
        let late = |bytes| sock(3, ESTABLISHED, (POD, 40002), (REMOTE, 443), 0, bytes);
        net.account(&[], &[], &groups(), &mut p, ME); // baseline
        let seen = net.account(&[fetch(1_000), late(10)], &[], &groups(), &mut p, ME);
        assert_eq!(seen.outbound, 1_010);

        // `fetch` closed after 300 more bytes; a connection shorter than a
        // sample (never dumped) counts whole, under `short-lived`; `late`
        // left the dump but its event isn't in yet.
        let short = sock(9, ESTABLISHED, (POD, 40001), (REMOTE, 80), 0, 7_000);
        let d = net.account(&[], &[fetch(1_300), short], &groups(), &mut p, ME);
        assert_eq!(d.outbound, 7_300);
        assert_eq!(
            by_name(&d),
            vec![
                ("acp".into(), true, 0, 300),
                ("short-lived".into(), false, 0, 7_000)
            ]
        );

        // Its late event counts from the last dump, not from zero.
        let d = net.account(&[], &[late(25)], &groups(), &mut p, ME);
        assert_eq!(d.outbound, 15);

        // Noise closing is still noise.
        let agent = sock(4, ESTABLISHED, (POD, crate::AGENT_PORT), (PEER, 1), 0, 900);
        let d = net.account(&[], &[agent], &groups(), &mut p, ME);
        assert_eq!((d.inbound, d.outbound), (0, 0));
    }

    #[test]
    fn an_unresolvable_owner_is_unknown() {
        let mut net = NetSampler::new();
        let mut p = procs();
        let dump = |bytes| {
            vec![sock(
                7,
                ESTABLISHED,
                (POD, 40001),
                (REMOTE, 443),
                999,
                bytes,
            )]
        };
        net.account(&dump(0), &[], &groups(), &mut p, ME);
        let d = net.account(&dump(10), &[], &groups(), &mut p, ME);
        assert_eq!(by_name(&d), vec![("unknown".into(), false, 0, 10)]);
    }

    #[test]
    fn loopback_detection_covers_v6_and_mapped_v4() {
        assert!(is_loopback(&"::1".parse().unwrap()));
        assert!(is_loopback(&"::ffff:127.0.0.1".parse().unwrap()));
        assert!(!is_loopback(&"::ffff:10.0.0.1".parse().unwrap()));
    }

    #[test]
    fn parses_proc_stat_and_socket_links() {
        assert_eq!(
            parse_proc_stat("42 (my (weird) proc) S 1 40 40 0 -1"),
            Some(("my (weird) proc".into(), 40))
        );
        assert_eq!(parse_socket_link("socket:[12345]"), Some(12345));
        assert_eq!(parse_socket_link("pipe:[1]"), None);
    }

    /// A fake kernel answer: one IPv4 socket with tcp_info, then DONE.
    fn kernel_reply(acked: u64, received: u64) -> Vec<u8> {
        let mut msg = vec![0u8; INET_DIAG_MSG_LEN];
        msg[0] = LINUX_AF_INET;
        msg[1] = ESTABLISHED;
        msg[4..6].copy_from_slice(&8080u16.to_be_bytes());
        msg[6..8].copy_from_slice(&51000u16.to_be_bytes());
        msg[8..12].copy_from_slice(&[10, 42, 0, 7]);
        msg[24..28].copy_from_slice(&[10, 42, 0, 1]);
        msg[44..48].copy_from_slice(&7u32.to_ne_bytes());
        msg[48..52].copy_from_slice(&1u32.to_ne_bytes());
        msg[68..72].copy_from_slice(&4242u32.to_ne_bytes());
        let mut info = vec![0u8; 232];
        info[TCPI_BYTES_ACKED..TCPI_BYTES_ACKED + 8].copy_from_slice(&acked.to_ne_bytes());
        info[TCPI_BYTES_RECEIVED..TCPI_BYTES_RECEIVED + 8].copy_from_slice(&received.to_ne_bytes());
        msg.extend_from_slice(&((info.len() + 4) as u16).to_ne_bytes());
        msg.extend_from_slice(&INET_DIAG_INFO.to_ne_bytes());
        msg.extend_from_slice(&info);

        let mut out = Vec::new();
        for (ty, payload) in [(SOCK_DIAG_BY_FAMILY, msg), (NLMSG_DONE, vec![0u8; 4])] {
            out.extend_from_slice(&((NLMSG_HDRLEN + payload.len()) as u32).to_ne_bytes());
            out.extend_from_slice(&ty.to_ne_bytes());
            out.extend_from_slice(&[0u8; 10]);
            out.extend_from_slice(&payload);
            while out.len() % 4 != 0 {
                out.push(0);
            }
        }
        out
    }

    #[test]
    fn parses_a_sock_diag_reply() {
        let mut sockets = Vec::new();
        assert_eq!(
            parse_messages(&kernel_reply(300, 1_200), &mut sockets),
            Parsed::Done
        );
        assert_eq!(
            sockets,
            vec![TcpSocket {
                cookie: 7 | (1 << 32),
                state: ESTABLISHED,
                src: POD,
                sport: 8080,
                dst: PEER,
                dport: 51000,
                inode: 4242,
                bytes: Some(1_500),
            }]
        );
    }

    #[test]
    fn surfaces_a_netlink_error() {
        let mut reply = Vec::new();
        reply.extend_from_slice(&(20u32).to_ne_bytes());
        reply.extend_from_slice(&NLMSG_ERROR.to_ne_bytes());
        reply.extend_from_slice(&[0u8; 10]);
        reply.extend_from_slice(&(-13i32).to_ne_bytes());
        assert_eq!(parse_messages(&reply, &mut Vec::new()), Parsed::Error(13));
    }

    #[test]
    fn builds_a_dump_request() {
        let req = build_request(LINUX_AF_INET6, 9);
        assert_eq!(req.len(), NLMSG_HDRLEN + INET_DIAG_REQ_LEN);
        assert_eq!(u32_at(&req, 0) as usize, req.len());
        assert_eq!(u16_at(&req, 4), SOCK_DIAG_BY_FAMILY);
        assert_eq!(&req[16..20], &[LINUX_AF_INET6, IPPROTO_TCP, 2, 0]);
    }

    /// The real kernel: a loopback connection shows up with its bytes.
    #[cfg(target_os = "linux")]
    #[test]
    fn dumps_live_sockets_with_byte_counters() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut client = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        client.write_all(&[7u8; 5000]).unwrap();
        let mut got = vec![0u8; 5000];
        server.read_exact(&mut got).unwrap();
        let sockets = dump().expect("sock_diag dump");
        let accepted = sockets
            .iter()
            .find(|s| s.sport == port && s.state == ESTABLISHED)
            .expect("the accepted socket");
        assert!(accepted.bytes.unwrap_or(0) >= 5000, "{accepted:?}");
        assert!(accepted.inode != 0);
        assert!(
            sockets
                .iter()
                .any(|s| s.sport == port && s.state == TCP_LISTEN)
        );
    }

    /// The real kernel: closing a connection broadcasts its final counters.
    #[cfg(target_os = "linux")]
    #[test]
    fn hears_closed_sockets_with_their_final_counters() {
        use std::io::{Read, Write};
        let Some(rx) = listen_destroyed() else {
            eprintln!("destroy broadcasts unavailable here; skipping");
            return;
        };
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        {
            let mut client = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let (mut server, _) = listener.accept().unwrap();
            client.write_all(&[1u8; 3000]).unwrap();
            let mut got = vec![0u8; 3000];
            server.read_exact(&mut got).unwrap();
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            let Ok(s) = rx.recv_timeout(std::time::Duration::from_millis(200)) else {
                continue;
            };
            if s.sport == port && s.bytes.unwrap_or(0) >= 3000 {
                return;
            }
        }
        panic!("no destroy event with the final byte counters");
    }
}
