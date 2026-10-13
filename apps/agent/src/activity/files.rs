//! File writes under the home (`/home/dev`, where repos are cloned), minus
//! excludes: dependency installs, build output, logs, and the tool state
//! hidden at the top of the home (caches, editor servers, shell history,
//! agent config). One fanotify mount mark on the `/home/dev` overlay
//! (`FAN_MODIFY | FAN_CLOSE_WRITE`) covers the whole tree with no
//! per-directory watch; each event carries an fd (→ path) and the writer's
//! pid (the agent's own writes are dropped). The mark is placed once the
//! overlay is assembled and re-placed if it is re-mounted. Without fanotify
//! the status is `unavailable`.

use std::sync::Arc;

use super::Activity;

const HOME: &str = "/home/dev";
/// Path components whose writes don't count: dependency installs, build
/// output, git housekeeping; `*.log` matches any name ending in `.log`.
const EXCLUDED: [&str; 10] = [
    "node_modules",
    ".git",
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    "dist",
    "build",
    "target",
    "*.log",
];

/// Whether a write to `path` counts as activity: under the home, not in a
/// hidden top-level entry (tool state: caches, editor servers, shell
/// history, agent config), no excluded component.
fn counts(path: &str) -> bool {
    let Some(rel) = path
        .strip_prefix(HOME)
        .and_then(|rest| rest.strip_prefix('/'))
    else {
        return false;
    };
    let excluded = |part: &str| {
        EXCLUDED.iter().any(|e| match e.strip_prefix('*') {
            Some(suffix) => part.ends_with(suffix),
            None => part == *e,
        })
    };
    !rel.is_empty() && !rel.starts_with('.') && !rel.split('/').any(excluded)
}

#[cfg(not(target_os = "linux"))]
pub fn spawn_watcher(activity: Arc<Activity>) {
    activity.set_files_status("unavailable");
}

#[cfg(target_os = "linux")]
pub fn spawn_watcher(activity: Arc<Activity>) {
    let status = activity.clone();
    let spawned = std::thread::Builder::new()
        .name("activity-files".into())
        .spawn(move || linux::run(&activity));
    if let Err(e) = spawned {
        eprintln!("atelier-agent: file activity watcher failed to start: {e}");
        status.set_files_status("unavailable");
    }
}

/// The mount id of the topmost mount on `mount_point` in a `mountinfo`.
fn mount_id_of(mountinfo: &str, mount_point: &str) -> Option<u64> {
    mountinfo
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let id = fields.next()?.parse().ok()?;
            (fields.nth(3)? == mount_point).then_some(id)
        })
        .next_back()
}

#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::CString;
    use std::io::Error;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::path::Path;
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::super::Activity;
    use super::{HOME, counts, mount_id_of};

    const POLL_MS: i32 = 5_000;

    pub fn run(activity: &Arc<Activity>) {
        loop {
            activity.set_files_status("pending");
            wait_for_home();
            match Fanotify::open(HOME) {
                Ok(fan) => {
                    activity.set_files_status("fanotify");
                    fan.run(activity);
                    // The overlay was re-mounted: mark the new one.
                }
                Err(e) => {
                    eprintln!("atelier-agent: file activity unavailable (fanotify: {e})");
                    activity.set_files_status("unavailable");
                    return;
                }
            }
        }
    }

    fn home_mount_id() -> Option<u64> {
        let mountinfo = std::fs::read_to_string("/proc/self/mountinfo").ok()?;
        mount_id_of(&mountinfo, HOME)
    }

    /// Until materialize assembled `/home/dev` (a mark placed before would
    /// sit on the mount underneath).
    fn wait_for_home() {
        while !Path::new(crate::toolset::HOME_READY_MARKER).exists() {
            std::thread::sleep(Duration::from_secs(2));
        }
    }

    fn wait_readable(fd: RawFd, timeout_ms: i32) -> bool {
        let mut pfd = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one valid pollfd.
        let ready = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
        ready > 0 && pfd.revents & libc::POLLIN != 0
    }

    /// Read what's available on a non-blocking fd (0 when drained).
    fn read_some(fd: RawFd, buf: &mut [u8]) -> usize {
        // SAFETY: valid fd; `buf` is writable for its whole length.
        let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
        if n > 0 { n as usize } else { 0 }
    }

    struct Fanotify {
        fd: OwnedFd,
        mount_id: Option<u64>,
    }

    impl Fanotify {
        fn open(path: &str) -> std::io::Result<Self> {
            // SAFETY: plain fanotify_init(2).
            let raw = unsafe {
                libc::fanotify_init(
                    libc::FAN_CLASS_NOTIF | libc::FAN_CLOEXEC | libc::FAN_NONBLOCK,
                    (libc::O_RDONLY | libc::O_LARGEFILE | libc::O_CLOEXEC) as libc::c_uint,
                )
            };
            if raw < 0 {
                return Err(Error::last_os_error());
            }
            // SAFETY: a fresh fd nobody else owns.
            let fd = unsafe { OwnedFd::from_raw_fd(raw) };
            let c_path = CString::new(path).map_err(Error::other)?;
            // SAFETY: valid fanotify fd and NUL-terminated path.
            let marked = unsafe {
                libc::fanotify_mark(
                    fd.as_raw_fd(),
                    libc::FAN_MARK_ADD | libc::FAN_MARK_MOUNT,
                    libc::FAN_MODIFY | libc::FAN_CLOSE_WRITE,
                    libc::AT_FDCWD,
                    c_path.as_ptr(),
                )
            };
            if marked < 0 {
                return Err(Error::last_os_error());
            }
            Ok(Self {
                fd,
                mount_id: home_mount_id(),
            })
        }

        /// Count matching writes until the overlay is re-mounted.
        fn run(&self, activity: &Activity) {
            let me = std::process::id() as i32;
            let mut buf = vec![0u8; 16 * 1024];
            let mut mount_checked = Instant::now();
            loop {
                let readable = wait_readable(self.fd.as_raw_fd(), POLL_MS);
                if mount_checked.elapsed() >= Duration::from_millis(POLL_MS as u64) {
                    mount_checked = Instant::now();
                    if home_mount_id() != self.mount_id {
                        return;
                    }
                }
                if !readable {
                    continue;
                }
                // One write per batch: a `git checkout` or an editor's save
                // is one burst of activity, not hundreds.
                let mut hit = false;
                loop {
                    let n = read_some(self.fd.as_raw_fd(), &mut buf);
                    if n == 0 {
                        break;
                    }
                    for event in parse_fanotify(&buf[..n]) {
                        if event.fd < 0 {
                            continue; // queue overflow: no fd, no path
                        }
                        if !hit && event.pid != me {
                            let link = std::fs::read_link(format!("/proc/self/fd/{}", event.fd));
                            hit = link
                                .ok()
                                .and_then(|p| p.to_str().map(counts))
                                .unwrap_or(false);
                        }
                        // SAFETY: the kernel opened this fd for us; we own it.
                        unsafe { libc::close(event.fd) };
                    }
                }
                if hit {
                    activity.add_file_write();
                }
            }
        }
    }

    struct FanotifyEvent {
        fd: i32,
        pid: i32,
    }

    /// `struct fanotify_event_metadata` records: event_len u32, vers u8,
    /// reserved u8, metadata_len u16, mask u64, fd i32, pid i32.
    fn parse_fanotify(buf: &[u8]) -> Vec<FanotifyEvent> {
        let i32_at =
            |at: usize| i32::from_ne_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]);
        let mut events = Vec::new();
        let mut off = 0;
        while off + 24 <= buf.len() {
            let len =
                u32::from_ne_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]]) as usize;
            if len < 24 || off + len > buf.len() {
                break;
            }
            events.push(FanotifyEvent {
                fd: i32_at(off + 16),
                pid: i32_at(off + 20),
            });
            off += len;
        }
        events
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parses_fanotify_records() {
            let mut fan = vec![0u8; 48];
            for (i, (fd, pid)) in [(5i32, 77i32), (-1, 0)].into_iter().enumerate() {
                let at = i * 24;
                fan[at..at + 4].copy_from_slice(&24u32.to_ne_bytes());
                fan[at + 16..at + 20].copy_from_slice(&fd.to_ne_bytes());
                fan[at + 20..at + 24].copy_from_slice(&pid.to_ne_bytes());
            }
            let events = parse_fanotify(&fan);
            assert_eq!(events.len(), 2);
            assert_eq!((events[0].fd, events[0].pid), (5, 77));
            assert_eq!(events[1].fd, -1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_repo_writes_but_not_tool_state_or_build_output() {
        assert!(counts("/home/dev/wallet/src/index.ts"));
        assert!(counts("/home/dev/wallet/.github/workflows/ci.yml"));
        assert!(counts("/home/dev/notes.md"));
        assert!(counts("/home/dev/wallet/logbook.md"));
        assert!(!counts("/home/dev/wallet/node_modules/x/y.js"));
        assert!(!counts("/home/dev/wallet/.git/FETCH_HEAD"));
        assert!(!counts("/home/dev/wallet/target/debug/app"));
        assert!(!counts("/home/dev/wallet/server.log"));
        assert!(!counts("/home/dev/.bash_history"));
        assert!(!counts("/home/dev/.npm/_cacache/index"));
        assert!(!counts("/home/dev/.pi/agent/sessions/s.jsonl"));
        assert!(!counts("/home/dev"));
        assert!(!counts("/home/dev-other/x"));
        assert!(!counts("/tmp/x"));
    }

    #[test]
    fn finds_the_topmost_mount() {
        let mountinfo = "\
22 1 0:21 / / rw - overlay overlay rw
40 22 0:33 / /home/dev rw - overlay overlay rw
41 22 0:34 / /data rw - ext4 /dev/vdb rw
57 22 0:35 / /home/dev rw - overlay overlay rw
";
        assert_eq!(mount_id_of(mountinfo, "/home/dev"), Some(57));
        assert_eq!(mount_id_of(mountinfo, "/nope"), None);
    }
}
