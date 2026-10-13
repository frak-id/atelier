//! CPU time consumed by the sandbox, sampled as a cumulative counter whose
//! deltas land in the activity buckets. Sources, best first: the
//! container's cgroup v2 `cpu.stat`, then `/proc/stat` (the whole guest: in a
//! Kata VM that *is* the sandbox; on a shared Docker host it would be the
//! host, which is why it comes last).

const CGROUP2_CPU_STAT: &str = "/sys/fs/cgroup/cpu.stat";
const PROC_STAT: &str = "/proc/stat";
/// `/proc/stat` ticks per second: 100 on every Linux the sandboxes run.
const USER_HZ: u64 = 100;

enum Source {
    Cgroup2,
    ProcStat,
    Unavailable,
}

pub struct CpuSampler {
    source: Source,
    /// The last cumulative reading, in ms.
    last: Option<u64>,
}

impl CpuSampler {
    pub fn detect() -> Self {
        let source = if read_cgroup2().is_some() {
            Source::Cgroup2
        } else if read_proc_stat().is_some() {
            Source::ProcStat
        } else {
            Source::Unavailable
        };
        let mut sampler = Self { source, last: None };
        sampler.last = sampler.read();
        sampler
    }

    pub fn status(&self) -> &'static str {
        match self.source {
            Source::Cgroup2 => "cgroup2",
            Source::ProcStat => "procstat",
            Source::Unavailable => "unavailable",
        }
    }

    fn read(&self) -> Option<u64> {
        match self.source {
            Source::Cgroup2 => read_cgroup2(),
            Source::ProcStat => read_proc_stat(),
            Source::Unavailable => None,
        }
    }

    /// CPU milliseconds used since the previous sample.
    pub fn sample(&mut self) -> u64 {
        let Some(now) = self.read() else { return 0 };
        let delta = self.last.map_or(0, |last| now.saturating_sub(last));
        self.last = Some(now);
        delta
    }
}

fn read_cgroup2() -> Option<u64> {
    parse_cgroup2_cpu_stat(&std::fs::read_to_string(CGROUP2_CPU_STAT).ok()?)
}

fn read_proc_stat() -> Option<u64> {
    parse_proc_stat(&std::fs::read_to_string(PROC_STAT).ok()?)
}

/// `usage_usec <n>` from a cgroup v2 `cpu.stat`, in ms.
fn parse_cgroup2_cpu_stat(content: &str) -> Option<u64> {
    content.lines().find_map(|line| {
        let usec: u64 = line.strip_prefix("usage_usec ")?.trim().parse().ok()?;
        Some(usec / 1000)
    })
}

/// Busy time from the aggregate `cpu` line of `/proc/stat` (user, nice,
/// system, irq, softirq, steal; not idle/iowait), in ms.
fn parse_proc_stat(content: &str) -> Option<u64> {
    let line = content.lines().find(|l| l.starts_with("cpu "))?;
    let fields: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .map(|f| f.parse().unwrap_or(0))
        .collect();
    let busy: u64 = [0, 1, 2, 5, 6, 7]
        .iter()
        .map(|&i| fields.get(i).copied().unwrap_or(0))
        .sum();
    Some(busy * 1000 / USER_HZ)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cgroup2_usage() {
        let stat = "usage_usec 2500000\nuser_usec 2000000\nsystem_usec 500000\n";
        assert_eq!(parse_cgroup2_cpu_stat(stat), Some(2500));
        assert_eq!(parse_cgroup2_cpu_stat("user_usec 1\n"), None);
    }

    #[test]
    fn parses_proc_stat_busy_time() {
        // user nice system idle iowait irq softirq steal
        let stat = "cpu  100 5 50 9000 40 3 2 1 0 0\ncpu0 1 2 3 4\n";
        // (100 + 5 + 50 + 3 + 2 + 1) ticks at 100/s = 1610 ms
        assert_eq!(parse_proc_stat(stat), Some(1610));
        assert_eq!(parse_proc_stat("intr 1 2\n"), None);
    }
}
