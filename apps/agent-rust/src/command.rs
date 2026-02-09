use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::watch;

fn kill_pid(pid: u32) {
    if pid <= 1 {
        return;
    }
    // SAFETY: best-effort kill; ignore errors (process may have already exited).
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

fn truncate_marker(truncated: bool) -> &'static str {
    if truncated {
        "\n[truncated]\n"
    } else {
        ""
    }
}

async fn read_limited<R: tokio::io::AsyncRead + Unpin>(
    reader: R,
    max_bytes: usize,
) -> (Vec<u8>, bool) {
    let mut limited = reader.take(max_bytes as u64);
    let mut buf = Vec::new();
    let n = limited.read_to_end(&mut buf).await.unwrap_or(0);
    (buf, (n as usize) >= max_bytes)
}

pub async fn run_shell_command_limited(
    command: &str,
    timeout_ms: u64,
    user: Option<&str>,
    workdir: Option<&str>,
    max_output_bytes: usize,
) -> serde_json::Value {
    let timeout = Duration::from_millis(timeout_ms);

    let mut cmd = Command::new("/bin/bash");
    cmd.args(["-l", "-c", command])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if user == Some("dev") {
        cmd.uid(1000).gid(1000);
        cmd.env("HOME", "/home/dev");
        cmd.env("USER", "dev");
    }

    if let Some(dir) = workdir {
        cmd.current_dir(dir);
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return serde_json::json!({
                "exitCode": 1,
                "stdout": "",
                "stderr": e.to_string()
            })
        }
    };

    let pid = child.id().unwrap_or(0);

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let (trunc_tx, mut trunc_rx) = watch::channel(false);

    let stdout_trunc_tx = trunc_tx.clone();
    let stdout_task = tokio::spawn(async move {
        match stdout {
            Some(s) => {
                let (buf, truncated) = read_limited(s, max_output_bytes).await;
                if truncated {
                    let _ = stdout_trunc_tx.send(true);
                }
                (buf, truncated)
            }
            None => (Vec::new(), false),
        }
    });
    let stderr_trunc_tx = trunc_tx.clone();
    let stderr_task = tokio::spawn(async move {
        match stderr {
            Some(s) => {
                let (buf, truncated) = read_limited(s, max_output_bytes).await;
                if truncated {
                    let _ = stderr_trunc_tx.send(true);
                }
                (buf, truncated)
            }
            None => (Vec::new(), false),
        }
    });

    let mut timed_out = false;

    let mut wait_fut = Box::pin(tokio::time::timeout(timeout, child.wait()));
    let mut killed = false;

    let exit_code = loop {
        tokio::select! {
            status = &mut wait_fut => {
                break match status {
                    Ok(Ok(s)) => s.code().unwrap_or(1),
                    Ok(Err(_)) => 1,
                    Err(_) => {
                        timed_out = true;
                        kill_pid(pid);
                        killed = true;
                        1
                    }
                };
            }
            changed = trunc_rx.changed() => {
                if changed.is_ok() && *trunc_rx.borrow() {
                    kill_pid(pid);
                    killed = true;
                }
            }
        }
    };

    // If the timeout fired, the `child.wait()` future was cancelled; explicitly reap.
    drop(wait_fut);
    if timed_out {
        let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
    }

    let (stdout_bytes, stdout_truncated) = stdout_task.await.unwrap_or((Vec::new(), false));
    let (stderr_bytes, stderr_truncated) = stderr_task.await.unwrap_or((Vec::new(), false));

    let mut stdout_str = String::from_utf8_lossy(&stdout_bytes).to_string();
    let mut stderr_str = String::from_utf8_lossy(&stderr_bytes).to_string();

    if stdout_truncated {
        stdout_str.push_str(truncate_marker(true));
    }
    if stderr_truncated {
        stderr_str.push_str(truncate_marker(true));
    }
    if timed_out {
        stderr_str.push_str("Command timed out\n");
    }
    if stdout_truncated || stderr_truncated {
        stderr_str.push_str("Output limit exceeded\n");
    }

    if killed && !(stdout_truncated || stderr_truncated || timed_out) {
        stderr_str.push_str("Command killed\n");
    }

    serde_json::json!({
        "exitCode": exit_code,
        "stdout": stdout_str,
        "stderr": stderr_str,
    })
}
