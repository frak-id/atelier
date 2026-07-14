//! One-shot shell command execution with output + time bounds. Shared by the
//! `exec` routes and the hook runner. Pod `env` (which may carry resolved
//! secrets) is passed in explicitly rather than read from a global, and
//! results are a typed struct.

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::watch;

pub const DEFAULT_EXEC_TIMEOUT_MS: u64 = 120_000;
pub const MAX_COMMAND_OUTPUT_BYTES: usize = 15 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Apply the v2 user model to a command: `dev` drops to uid/gid 1000 with a
/// dev HOME; anything else runs as the agent's uid (root in-pod).
pub fn apply_user(cmd: &mut Command, user: Option<&str>) {
    if user == Some("dev") {
        cmd.uid(1000).gid(1000);
        cmd.env("HOME", "/home/dev");
        cmd.env("USER", "dev");
    }
}

fn kill_pid(pid: u32) {
    if pid <= 1 {
        return;
    }
    // SAFETY: best-effort kill; the process may have already exited.
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

async fn read_limited<R: tokio::io::AsyncRead + Unpin>(reader: R, max: usize) -> (Vec<u8>, bool) {
    let mut limited = reader.take(max as u64);
    let mut buf = Vec::new();
    let n = limited.read_to_end(&mut buf).await.unwrap_or(0);
    (buf, n >= max)
}

/// Run `command` under `/bin/bash -l -c`, bounded by `timeout_ms` and
/// `max_output_bytes`. `env` is layered onto the process environment (pod env +
/// per-call additions); `user`/`workdir` follow the v2 user model.
pub async fn run(
    command: &str,
    timeout_ms: u64,
    user: Option<&str>,
    workdir: Option<&str>,
    env: &HashMap<String, String>,
    max_output_bytes: usize,
) -> ExecResult {
    let timeout = Duration::from_millis(timeout_ms);

    let mut cmd = Command::new("/bin/bash");
    cmd.args(["-l", "-c", command])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
    let pid = child.id().unwrap_or(0);
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // A stream that blows the output cap kills the process (via the watch),
    // so a runaway writer can't exhaust memory.
    let (trunc_tx, mut trunc_rx) = watch::channel(false);
    let out_tx = trunc_tx.clone();
    let stdout_task = tokio::spawn(async move {
        match stdout {
            Some(s) => {
                let (buf, t) = read_limited(s, max_output_bytes).await;
                if t {
                    let _ = out_tx.send(true);
                }
                (buf, t)
            }
            None => (Vec::new(), false),
        }
    });
    let err_tx = trunc_tx;
    let stderr_task = tokio::spawn(async move {
        match stderr {
            Some(s) => {
                let (buf, t) = read_limited(s, max_output_bytes).await;
                if t {
                    let _ = err_tx.send(true);
                }
                (buf, t)
            }
            None => (Vec::new(), false),
        }
    });

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
                        kill_pid(pid);
                        1
                    }
                };
            }
            changed = trunc_rx.changed() => {
                if changed.is_ok() && *trunc_rx.borrow() {
                    kill_pid(pid);
                }
            }
        }
    };
    drop(wait_fut);
    if timed_out {
        let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    }

    let (stdout_bytes, stdout_trunc) = stdout_task.await.unwrap_or((Vec::new(), false));
    let (stderr_bytes, stderr_trunc) = stderr_task.await.unwrap_or((Vec::new(), false));
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
}
