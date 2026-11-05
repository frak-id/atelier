//! One-shot shell command execution with output + time bounds. Shared by the
//! `exec` routes and the hook runner. Pod `env` (which may carry resolved
//! secrets) is passed in explicitly rather than read from a global, and
//! results are a typed struct.

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::watch;

use crate::supervisor::signal_group;

pub const DEFAULT_EXEC_TIMEOUT_MS: u64 = 120_000;
pub const MAX_COMMAND_OUTPUT_BYTES: usize = 15 * 1024 * 1024;
/// How long to wait for the output pipes to close once the shell has exited
/// (or been killed). A descendant that escaped the group, or one backgrounded
/// without redirecting its output, keeps a pipe open indefinitely; we return
/// what was read instead of hanging the call and its exec permit.
const PIPE_DRAIN_GRACE: Duration = Duration::from_secs(2);
const CHUNK_BYTES: usize = 8192;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Apply the spec's user model to a command: `dev` drops to uid/gid 1000 with a
/// dev HOME; anything else runs as the agent's uid (root in-pod).
pub fn apply_user(cmd: &mut Command, user: Option<&str>) {
    if user == Some("dev") {
        cmd.uid(1000).gid(1000);
        cmd.env("HOME", "/home/dev");
        cmd.env("USER", "dev");
    }
}

/// Collect up to `max` bytes of `reader` into `buf` (shared so what was read
/// survives an aborted drain). Reaching `max` flags `capped` and stops.
async fn collect_limited<R: AsyncRead + Unpin>(
    mut reader: R,
    buf: Arc<Mutex<Vec<u8>>>,
    max: usize,
    capped: watch::Sender<bool>,
) {
    let mut chunk = [0u8; CHUNK_BYTES];
    loop {
        let n = match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        let mut buf = buf.lock().expect("output buffer lock");
        let room = max.saturating_sub(buf.len());
        buf.extend_from_slice(&chunk[..n.min(room)]);
        if buf.len() >= max {
            let _ = capped.send(true);
            return;
        }
    }
}

/// Run `command` under a login shell (`/bin/bash -l -c`), bounded by
/// `timeout_ms` and `max_output_bytes`. `env` is layered onto the process
/// environment (pod env + per-call additions); `user`/`workdir` follow the
/// spec's user model. Thin wrapper over `run_with_login` that preserves every
/// existing caller's behavior (exec routes, hooks, `build`/`capture`) — the
/// login shell is the default so those callers need no change.
pub async fn run(
    command: &str,
    timeout_ms: u64,
    user: Option<&str>,
    workdir: Option<&str>,
    env: &HashMap<String, String>,
    max_output_bytes: usize,
) -> ExecResult {
    run_with_login(
        command,
        timeout_ms,
        user,
        workdir,
        env,
        max_output_bytes,
        true,
    )
    .await
}

/// Same as `run`, with an explicit `login` choice. `login: false` runs under
/// a plain `/bin/bash -c` instead of `-l -c` — skips sourcing `/etc/profile`
/// and every `profile.d/*.sh` script, a cost a purely root-run
/// mkdir/mount/find/rm plumbing script (the agent's toolset
/// materialize/cleanup/overlay/sweep scripts — see `toolset.rs`) never
/// benefits from paying on every invocation. `readiness.rs`'s `probe_cmd`
/// already set this non-login precedent for the same reason.
///
/// The shell leads its own process group, so a timeout or an output-cap
/// overrun kills the whole tree (`npm test`, `mksquashfs`, `oras`…), not just
/// the shell.
pub async fn run_with_login(
    command: &str,
    timeout_ms: u64,
    user: Option<&str>,
    workdir: Option<&str>,
    env: &HashMap<String, String>,
    max_output_bytes: usize,
    login: bool,
) -> ExecResult {
    run_bash(
        command,
        &[],
        timeout_ms,
        user,
        workdir,
        env,
        max_output_bytes,
        login,
    )
    .await
}

/// Run an embedded script file (apps/agent/scripts) as `bash -c <script> bash
/// <args...>`: user-controlled values arrive as positional parameters
/// (`$1…`), fixed settings through `env`, and nothing is interpolated into
/// the script text. Same bounds and process-group handling as `run`.
pub async fn run_script(
    script: &str,
    args: &[String],
    timeout_ms: u64,
    user: Option<&str>,
    env: &HashMap<String, String>,
    login: bool,
) -> ExecResult {
    run_bash(
        script,
        args,
        timeout_ms,
        user,
        None,
        env,
        MAX_COMMAND_OUTPUT_BYTES,
        login,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_bash(
    command: &str,
    script_args: &[String],
    timeout_ms: u64,
    user: Option<&str>,
    workdir: Option<&str>,
    env: &HashMap<String, String>,
    max_output_bytes: usize,
    login: bool,
) -> ExecResult {
    let timeout = Duration::from_millis(timeout_ms);

    let mut cmd = Command::new("/bin/bash");
    if login {
        cmd.args(["-l", "-c", command]);
    } else {
        cmd.args(["-c", command]);
    }
    if !script_args.is_empty() {
        // `$0`, then `$1…`.
        cmd.arg("bash").args(script_args);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    for (k, v) in env {
        cmd.env(k, v);
    }
    // apply_user after env so USER/HOME win for the dev user.
    apply_user(&mut cmd, user);
    if let Some(dir) = workdir {
        cmd.current_dir(dir);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return ExecResult {
                exit_code: 1,
                stdout: String::new(),
                stderr: e.to_string(),
            };
        }
    };
    // pgid == pid (process_group(0)).
    let pgid = child.id().unwrap_or(0);

    // A stream that blows the output cap kills the group (via the watch), so
    // a runaway writer can't exhaust memory.
    let (capped_tx, mut capped_rx) = watch::channel(false);
    let stdout_buf = Arc::new(Mutex::new(Vec::new()));
    let stderr_buf = Arc::new(Mutex::new(Vec::new()));
    let mut readers = Vec::new();
    if let Some(s) = child.stdout.take() {
        readers.push(tokio::spawn(collect_limited(
            s,
            stdout_buf.clone(),
            max_output_bytes,
            capped_tx.clone(),
        )));
    }
    if let Some(s) = child.stderr.take() {
        readers.push(tokio::spawn(collect_limited(
            s,
            stderr_buf.clone(),
            max_output_bytes,
            capped_tx,
        )));
    }

    let mut timed_out = false;
    let mut wait_fut = Box::pin(tokio::time::timeout(timeout, child.wait()));
    let exit_code = loop {
        tokio::select! {
            status = &mut wait_fut => {
                break match status {
                    Ok(Ok(s)) => s.code().unwrap_or(1),
                    Ok(Err(_)) => 1,
                    Err(_) => {
                        timed_out = true;
                        signal_group(pgid, libc::SIGKILL);
                        1
                    }
                };
            }
            changed = capped_rx.changed() => {
                if changed.is_ok() && *capped_rx.borrow() {
                    signal_group(pgid, libc::SIGKILL);
                }
            }
        }
    };
    drop(wait_fut);
    if timed_out {
        let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    }

    // Bounded wait for the pipes to close; whatever was read is kept.
    let drain = async {
        for reader in &mut readers {
            let _ = reader.await;
        }
    };
    if tokio::time::timeout(PIPE_DRAIN_GRACE, drain).await.is_err() {
        for reader in &readers {
            reader.abort();
        }
    }

    let take = |buf: &Arc<Mutex<Vec<u8>>>| std::mem::take(&mut *buf.lock().expect("output lock"));
    let stdout_bytes = take(&stdout_buf);
    let stderr_bytes = take(&stderr_buf);
    let stdout_trunc = stdout_bytes.len() >= max_output_bytes;
    let stderr_trunc = stderr_bytes.len() >= max_output_bytes;
    let mut stdout_str = String::from_utf8_lossy(&stdout_bytes).into_owned();
    let mut stderr_str = String::from_utf8_lossy(&stderr_bytes).into_owned();
    if timed_out {
        stderr_str.push_str("Command timed out\n");
    }
    if stdout_trunc || stderr_trunc {
        stderr_str.push_str("Output limit exceeded\n");
    }
    if stdout_trunc {
        stdout_str.push_str("\n[truncated]\n");
    }
    if stderr_trunc {
        stderr_str.push_str("\n[truncated]\n");
    }
    ExecResult {
        exit_code,
        stdout: stdout_str,
        stderr: stderr_str,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn injects_env_and_captures_output() {
        let mut env = HashMap::new();
        env.insert("GREETING".to_string(), "hello".to_string());
        let out = run("echo $GREETING", 5000, None, None, &env, 4096).await;
        assert_eq!(out.exit_code, 0);
        assert_eq!(out.stdout.trim(), "hello");
    }

    #[tokio::test]
    async fn nonzero_exit_is_reported() {
        let out = run("exit 7", 5000, None, None, &HashMap::new(), 4096).await;
        assert_eq!(out.exit_code, 7);
    }

    #[tokio::test]
    async fn timeout_kills_a_backgrounded_grandchild() {
        // `sleep` holds the stdout pipe; killing only the shell would leave
        // the call waiting out the drain grace (or forever, before it was
        // bounded). Killing the group closes the pipe at once.
        let start = std::time::Instant::now();
        let out = run("sleep 300 & wait", 300, None, None, &HashMap::new(), 4096).await;
        let elapsed = start.elapsed();
        assert_eq!(out.exit_code, 1);
        assert!(out.stderr.contains("Command timed out"), "{}", out.stderr);
        assert!(
            elapsed < PIPE_DRAIN_GRACE,
            "returned after {elapsed:?}; the group kill should free the pipe immediately"
        );
    }

    #[tokio::test]
    async fn output_overflow_kills_the_group() {
        let start = std::time::Instant::now();
        let out = run("yes | cat", 30_000, None, None, &HashMap::new(), 1024).await;
        assert!(
            out.stderr.contains("Output limit exceeded"),
            "{}",
            out.stderr
        );
        assert!(out.stdout.ends_with("[truncated]\n"));
        assert!(start.elapsed() < Duration::from_secs(10));
    }

    #[tokio::test]
    async fn pipe_drain_after_exit_is_bounded() {
        // The shell exits at once but a daemonized child keeps stdout open.
        let start = std::time::Instant::now();
        let out = run(
            "sleep 30 & echo hi",
            30_000,
            None,
            None,
            &HashMap::new(),
            4096,
        )
        .await;
        assert_eq!(out.exit_code, 0);
        assert_eq!(out.stdout.trim(), "hi");
        assert!(start.elapsed() < PIPE_DRAIN_GRACE + Duration::from_secs(5));
    }
}
