//! File writes under the roots (default `/home/dev`, where repos are
//! cloned), minus excludes: dependency installs, build output, logs, and the
//! tool state hidden at the top of the home (caches, editor servers, shell
//! history, agent config). One fanotify mount mark on the `/home/dev`
//! overlay (`FAN_MODIFY | FAN_CLOSE_WRITE`) covers the whole tree with no
//! per-directory watch and no `max_user_watches` ceiling; each event carries
//! an fd (→ path) and the writer's pid (the agent's own writes are dropped).
//! The mark is placed once the overlay is assembled and re-placed if it is
//! re-mounted. Fallback when fanotify isn't available: inotify on the roots
//! minus excluded directories, capped.

use std::sync::Arc;

use super::{Activity, FileSettings};

/// Which writes count. Excludes are directory/file names (`node_modules`,
/// `.git`), `*.ext` suffixes, or absolute path patterns (`/home/dev/.*`: a
/// leading `/`, components matched with `*` wildcards, everything under a
/// match excluded).
#[derive(Debug, Clone, Default)]
pub struct FileFilter {
    /// Normalized roots without a trailing slash (`""` = `/`).
    roots: Vec<String>,
    names: Vec<String>,
    suffixes: Vec<String>,
    /// Absolute exclude patterns, one entry per path component.
    patterns: Vec<Vec<String>>,
}

/// `*`-wildcard match of one path component.
fn glob(pattern: &str, s: &str) -> bool {
    let Some((first, rest)) = pattern.split_once('*') else {
        return pattern == s;
    };
    let Some(mut s) = s.strip_prefix(first) else {
        return false;
    };
    let mut parts: Vec<&str> = rest.split('*').collect();
    let last = parts.pop().unwrap_or("");
    for part in parts {
        match s.find(part) {
            Some(i) => s = &s[i + part.len()..],
            None => return false,
        }
    }
    s.len() >= last.len() && s.ends_with(last)
}

impl FileFilter {
    pub fn new(settings: &FileSettings) -> Self {
        let mut filter = Self::default();
        for root in &settings.roots {
            let root = root.trim();
            if root.starts_with('/') {
                filter.roots.push(root.trim_end_matches('/').to_string());
            }
        }
        for exclude in &settings.exclude {
            let exclude = exclude.trim();
            if exclude.starts_with('/') {
                let parts: Vec<String> = exclude
                    .split('/')
                    .filter(|p| !p.is_empty())
                    .map(String::from)
                    .collect();
                if !parts.is_empty() {
                    filter.patterns.push(parts);
                }
            } else if let Some(suffix) = exclude.strip_prefix('*') {
                if !suffix.is_empty() {
                    filter.suffixes.push(suffix.to_string());
                }
            } else if !exclude.is_empty() {
                filter.names.push(exclude.to_string());
            }
        }
        filter
    }

    pub fn roots(&self) -> impl Iterator<Item = &str> {
        self.roots
            .iter()
            .map(|r| if r.is_empty() { "/" } else { r.as_str() })
    }

    pub fn matches(&self, path: &str) -> bool {
        let Some(rel) = self.roots.iter().find_map(|root| {
            if path == root {
                Some("")
            } else {
                path.strip_prefix(root.as_str())?.strip_prefix('/')
            }
        }) else {
            return false;
        };
        if rel
            .split('/')
            .any(|part| self.names.iter().any(|n| n == part))
        {
            return false;
        }
        let file = rel.rsplit('/').next().unwrap_or(rel);
        !self.suffixes.iter().any(|s| file.ends_with(s.as_str())) && !self.excluded_by_pattern(path)
    }

    fn excluded_by_pattern(&self, path: &str) -> bool {
        let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
        self.patterns.iter().any(|pattern| {
            pattern.len() <= parts.len() && pattern.iter().zip(&parts).all(|(p, s)| glob(p, s))
        })
    }

    /// Whether to watch inside this directory (inotify).
    pub fn descends_into(&self, dir: &str) -> bool {
        let name = dir.rsplit('/').next().unwrap_or(dir);
        !self.names.iter().any(|n| n == name) && !self.excluded_by_pattern(dir)
    }
}

#[cfg(not(target_os = "linux"))]
pub fn spawn_watcher(activity: Arc<Activity>) {
    activity.set_files_status("unavailable");
}

#[cfg(target_os = "linux")]
pub fn spawn_watcher(activity: Arc<Activity>) {
    let spawned = std::thread::Builder::new()
        .name("activity-files".into())
        .spawn(move || linux::run(&activity));
    if let Err(e) = spawned {
        eprintln!("atelier-agent: file activity watcher failed to start: {e}");
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
    use std::collections::HashMap;
    use std::ffi::CString;
    use std::io::Error;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    use super::super::Activity;
    use super::{FileFilter, mount_id_of};

    const HOME: &str = "/home/dev";
    const POLL_MS: i32 = 5_000;
    const MAX_INOTIFY_WATCHES: usize = 8_192;
    /// With no root to watch yet (workspace not cloned), look again this
    /// often.
    const INOTIFY_RESCAN: Duration = Duration::from_secs(60);

    static FANOTIFY_WARNED: AtomicBool = AtomicBool::new(false);

    pub fn run(activity: &Arc<Activity>) {
        loop {
            activity.set_files_status("pending");
            wait_for_home();
            match Fanotify::open(HOME) {
                Ok(fan) => {
                    activity.set_files_status("fanotify");
                    fan.run(activity);
                    // The overlay was re-mounted: mark the new one.
                    continue;
                }
                Err(e) => {
                    if !FANOTIFY_WARNED.swap(true, Ordering::Relaxed) {
                        eprintln!("atelier-agent: fanotify unavailable ({e}); using inotify");
                    }
                }
            }
            if let Err(e) = inotify_run(activity) {
                eprintln!("atelier-agent: file activity unavailable: {e}");
                activity.set_files_status("unavailable");
                std::thread::sleep(Duration::from_secs(60));
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
            let (settings, mut version) = activity.settings();
            let mut filter = FileFilter::new(&settings);
            let mut buf = vec![0u8; 16 * 1024];
            let mut mount_checked = Instant::now();
            loop {
                let readable = wait_readable(self.fd.as_raw_fd(), POLL_MS);
                let (settings, v) = activity.settings();
                if v != version {
                    filter = FileFilter::new(&settings);
                    version = v;
                }
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
                                .and_then(|p| p.to_str().map(|p| filter.matches(p)))
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

    /// The fallback: inotify on every directory under the roots, minus
    /// excluded ones. Returns to rebuild on a settings change, or when no
    /// root existed yet.
    fn inotify_run(activity: &Activity) -> std::io::Result<()> {
        // SAFETY: plain inotify_init1(2).
        let raw = unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) };
        if raw < 0 {
            return Err(Error::last_os_error());
        }
        // SAFETY: a fresh fd nobody else owns.
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        let (settings, version) = activity.settings();
        let filter = FileFilter::new(&settings);
        let mut dirs: HashMap<i32, PathBuf> = HashMap::new();
        for root in filter.roots() {
            watch_tree(fd.as_raw_fd(), Path::new(root), &filter, &mut dirs);
        }
        activity.set_files_status("inotify");
        let started = Instant::now();
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let readable = wait_readable(fd.as_raw_fd(), POLL_MS);
            if activity.settings().1 != version
                || (dirs.is_empty() && started.elapsed() >= INOTIFY_RESCAN)
            {
                return Ok(());
            }
            if !readable {
                continue;
            }
            let mut hit = false;
            loop {
                let n = read_some(fd.as_raw_fd(), &mut buf);
                if n == 0 {
                    break;
                }
                for (wd, mask, name) in parse_inotify(&buf[..n]) {
                    if mask & libc::IN_IGNORED != 0 {
                        dirs.remove(&wd);
                        continue;
                    }
                    let Some(dir) = dirs.get(&wd) else { continue };
                    let path = dir.join(&name);
                    if mask & libc::IN_ISDIR != 0 {
                        if mask & (libc::IN_CREATE | libc::IN_MOVED_TO) != 0
                            && path.to_str().is_some_and(|p| filter.descends_into(p))
                        {
                            watch_tree(fd.as_raw_fd(), &path, &filter, &mut dirs);
                        }
                    } else if !hit {
                        hit = path.to_str().is_some_and(|p| filter.matches(p));
                    }
                }
            }
            if hit {
                activity.add_file_write();
            }
        }
    }

    fn watch_tree(fd: RawFd, dir: &Path, filter: &FileFilter, dirs: &mut HashMap<i32, PathBuf>) {
        let mut stack = vec![dir.to_path_buf()];
        while let Some(dir) = stack.pop() {
            if dirs.len() >= MAX_INOTIFY_WATCHES {
                return;
            }
            let Some(c_dir) = dir.to_str().and_then(|d| CString::new(d).ok()) else {
                continue;
            };
            let mask = libc::IN_CLOSE_WRITE
                | libc::IN_MODIFY
                | libc::IN_CREATE
                | libc::IN_MOVED_TO
                | libc::IN_ONLYDIR;
            // SAFETY: valid inotify fd and NUL-terminated path.
            let wd = unsafe { libc::inotify_add_watch(fd, c_dir.as_ptr(), mask) };
            if wd < 0 {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                dirs.insert(wd, dir);
                continue;
            };
            for entry in entries.flatten() {
                let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
                let path = entry.path();
                if is_dir && path.to_str().is_some_and(|p| filter.descends_into(p)) {
                    stack.push(path);
                }
            }
            dirs.insert(wd, dir);
        }
    }

    /// `struct inotify_event` records: wd i32, mask u32, cookie u32, len
    /// u32, then a NUL-padded name of `len` bytes.
    fn parse_inotify(buf: &[u8]) -> Vec<(i32, u32, String)> {
        let u32_at =
            |at: usize| u32::from_ne_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]);
        let mut events = Vec::new();
        let mut off = 0;
        while off + 16 <= buf.len() {
            let len = u32_at(off + 12) as usize;
            if off + 16 + len > buf.len() {
                break;
            }
            let name = &buf[off + 16..off + 16 + len];
            let name = name.split(|&b| b == 0).next().unwrap_or_default();
            events.push((
                u32_at(off) as i32,
                u32_at(off + 4),
                String::from_utf8_lossy(name).into_owned(),
            ));
            off += 16 + len;
        }
        events
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::activity::FileSettings;

        #[test]
        fn inotify_counts_writes_under_a_root_and_follows_new_dirs() {
            let root =
                std::env::temp_dir().join(format!("activity-inotify-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(root.join("node_modules")).unwrap();
            let activity = Activity::new();
            let root_str = root.to_str().unwrap().to_string();
            activity.set_settings(FileSettings {
                roots: vec![root_str.clone()],
                exclude: vec!["node_modules".into(), format!("{root_str}/.*")],
            });
            let watcher = {
                let activity = activity.clone();
                std::thread::spawn(move || {
                    let _ = inotify_run(&activity);
                })
            };
            std::thread::sleep(Duration::from_millis(300));
            std::fs::write(root.join("node_modules/ignored.js"), "x").unwrap();
            std::thread::sleep(Duration::from_millis(300));
            assert_eq!(activity.report()["buckets"].as_array().unwrap().len(), 0);

            std::fs::create_dir_all(root.join("src")).unwrap();
            std::thread::sleep(Duration::from_millis(300));
            std::fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
            std::thread::sleep(Duration::from_millis(500));
            let report = activity.report();
            assert_eq!(report["files"], "inotify");
            let writes = report["buckets"][0]["fileWrites"].as_u64().unwrap_or(0);
            assert!(writes >= 1);

            // Hidden tool state at the top of the root (an absolute pattern)
            // isn't watched, even in a directory created after the start.
            std::fs::create_dir_all(root.join(".tool")).unwrap();
            std::thread::sleep(Duration::from_millis(300));
            std::fs::write(root.join(".tool/state.json"), "{}").unwrap();
            std::thread::sleep(Duration::from_millis(500));
            assert_eq!(activity.report()["buckets"][0]["fileWrites"], writes);

            // A settings change makes the watcher return to rebuild.
            activity.set_settings(FileSettings::default());
            watcher.join().unwrap();
            let _ = std::fs::remove_dir_all(&root);
        }

        #[test]
        fn parses_fanotify_and_inotify_records() {
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

            let mut ino = Vec::new();
            ino.extend_from_slice(&3i32.to_ne_bytes());
            ino.extend_from_slice(&libc::IN_CLOSE_WRITE.to_ne_bytes());
            ino.extend_from_slice(&0u32.to_ne_bytes());
            ino.extend_from_slice(&8u32.to_ne_bytes());
            ino.extend_from_slice(b"a.ts\0\0\0\0");
            assert_eq!(
                parse_inotify(&ino),
                vec![(3, libc::IN_CLOSE_WRITE, "a.ts".into())]
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter(roots: &[&str], exclude: &[&str]) -> FileFilter {
        let strings = |list: &[&str]| list.iter().map(|s| s.to_string()).collect();
        FileFilter::new(&FileSettings {
            roots: strings(roots),
            exclude: strings(exclude),
        })
    }

    #[test]
    fn matches_under_roots_minus_excludes() {
        let f = filter(
            &["/home/dev/workspace/", "/srv"],
            &["node_modules", ".git", "*.log", "  "],
        );
        assert!(f.matches("/home/dev/workspace/app/src/main.ts"));
        assert!(f.matches("/srv/data.json"));
        assert!(!f.matches("/home/dev/.bashrc"));
        assert!(!f.matches("/home/dev/workspace-other/x"));
        assert!(!f.matches("/home/dev/workspace/app/node_modules/x/index.js"));
        assert!(!f.matches("/home/dev/workspace/app/.git/FETCH_HEAD"));
        assert!(!f.matches("/home/dev/workspace/app/server.log"));
        assert!(f.matches("/home/dev/workspace/app/logbook.md"));
        assert!(f.descends_into("/home/dev/workspace/app/src"));
        assert!(!f.descends_into("/home/dev/workspace/app/node_modules"));
    }

    #[test]
    fn root_slash_and_relative_roots() {
        let f = filter(&["/", "relative/dir"], &[]);
        assert!(f.matches("/etc/hosts"));
        assert_eq!(f.roots().collect::<Vec<_>>(), vec!["/"]);
        assert!(!filter(&[], &[]).matches("/home/dev/workspace/x"));
    }

    #[test]
    fn the_defaults_count_repos_in_the_home_but_not_tool_state() {
        let f = FileFilter::new(&FileSettings::default());
        assert!(f.matches("/home/dev/wallet/src/index.ts"));
        assert!(f.matches("/home/dev/wallet/.github/workflows/ci.yml"));
        assert!(f.matches("/home/dev/notes.md"));
        assert!(!f.matches("/home/dev/wallet/node_modules/x/y.js"));
        assert!(!f.matches("/home/dev/.bash_history"));
        assert!(!f.matches("/home/dev/.npm/_cacache/index"));
        assert!(!f.matches("/home/dev/.pi/agent/sessions/s.jsonl"));
        assert!(!f.descends_into("/home/dev/.local"));
        assert!(f.descends_into("/home/dev/wallet/.github"));
    }

    #[test]
    fn absolute_patterns_glob_per_component() {
        let f = filter(&["/"], &["/home/dev/.*", "/srv/*-cache", "/tmp"]);
        assert!(!f.matches("/home/dev/.npm/x"));
        assert!(!f.matches("/home/dev/.bashrc"));
        assert!(f.matches("/home/dev/app/.env"));
        assert!(!f.matches("/srv/build-cache/a"));
        assert!(f.matches("/srv/cachet/a"));
        assert!(!f.matches("/tmp/x"));
        assert!(f.matches("/tmpfile"));
        assert!(glob("a*b*c", "aXbYc"));
        assert!(!glob("a*a", "a"));
        assert!(glob("*", ""));
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
