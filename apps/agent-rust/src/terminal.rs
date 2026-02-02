use std::ffi::CString;
use futures_util::{SinkExt, StreamExt};
use nix::sys::signal::{kill, Signal};
use nix::unistd::{close, dup2, execvp, fork, setgid, setsid, setuid, ForkResult, Gid, Pid, Uid};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

fn raw_openpty() -> Option<(i32, i32)> {
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let ret = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ret == 0 {
        Some((master, slave))
    } else {
        None
    }
}

async fn ensure_devpts() {
    let _ = tokio::process::Command::new("mount")
        .args(["-t", "devpts", "devpts", "/dev/pts"])
        .status()
        .await;
}

fn set_winsize(fd: i32, cols: u16, rows: u16) {
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe {
        libc::ioctl(fd, libc::TIOCSWINSZ, &ws);
    }
}

async fn handle_connection(stream: tokio::net::TcpStream) {
    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("terminal: ws handshake failed: {e}");
            return;
        }
    };

    let (master_fd, slave_fd) = match raw_openpty() {
        Some(fds) => fds,
        None => {
            eprintln!("terminal: openpty failed");
            return;
        }
    };

    set_winsize(master_fd, 80, 24);

    let child_pid = match unsafe { fork() } {
        Ok(ForkResult::Child) => {
            unsafe { libc::close(master_fd) };

            let _ = setsid();

            unsafe {
                libc::ioctl(slave_fd, libc::TIOCSCTTY, 0);
            }

            let _ = dup2(slave_fd, 0);
            let _ = dup2(slave_fd, 1);
            let _ = dup2(slave_fd, 2);

            if slave_fd > 2 {
                let _ = close(slave_fd);
            }

            std::env::set_var("TERM", "xterm-256color");
            std::env::set_var("HOME", "/home/dev");
            std::env::set_var("USER", "dev");
            std::env::set_var("SHELL", "/bin/bash");

            let _ = setgid(Gid::from_raw(1000));
            let _ = setuid(Uid::from_raw(1000));

            let cmd = CString::new("/bin/bash").unwrap();
            let args = [CString::new("/bin/bash").unwrap()];
            let _ = execvp(&cmd, &args);
            std::process::exit(1);
        }
        Ok(ForkResult::Parent { child }) => {
            unsafe { libc::close(slave_fd) };
            child
        }
        Err(e) => {
            eprintln!("terminal: fork failed: {e}");
            unsafe {
                libc::close(master_fd);
                libc::close(slave_fd);
            }
            return;
        }
    };

    let (ws_write_tx, mut ws_write_rx) = mpsc::channel::<Message>(64);
    let (mut ws_sink, mut ws_source) = ws_stream.split();

    let pty_read_tx = ws_write_tx.clone();
    let pty_reader = tokio::spawn(async move {
        loop {
            let tx = pty_read_tx.clone();
            let fd = master_fd;
            let result = tokio::task::spawn_blocking(move || {
                let mut buf = [0u8; 4096];
                let n = unsafe { libc::read(fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
                if n > 0 {
                    Some(buf[..n as usize].to_vec())
                } else {
                    None
                }
            })
            .await;

            match result {
                Ok(Some(data)) => {
                    if tx.send(Message::Binary(data.into())).await.is_err() {
                        break;
                    }
                }
                _ => break,
            }
        }
    });

    let ws_writer = tokio::spawn(async move {
        while let Some(msg) = ws_write_rx.recv().await {
            if ws_sink.send(msg).await.is_err() {
                break;
            }
        }
        let _ = ws_sink.close().await;
    });

    let ws_reader = tokio::spawn(async move {
        while let Some(Ok(msg)) = ws_source.next().await {
            match msg {
                Message::Binary(data) => {
                    let fd = master_fd;
                    let bytes: Vec<u8> = data.into();
                    let _ = tokio::task::spawn_blocking(move || unsafe {
                        libc::write(fd, bytes.as_ptr() as *const libc::c_void, bytes.len());
                    })
                    .await;
                }
                Message::Text(text) => {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                        if val.get("type").and_then(|t| t.as_str()) == Some("resize") {
                            let cols =
                                val.get("cols").and_then(|c| c.as_u64()).unwrap_or(80) as u16;
                            let rows =
                                val.get("rows").and_then(|r| r.as_u64()).unwrap_or(24) as u16;
                            set_winsize(master_fd, cols, rows);
                        }
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = pty_reader => {}
        _ = ws_reader => {}
    }

    let _ = kill(Pid::from_raw(-child_pid.as_raw()), Signal::SIGHUP);
    unsafe { libc::close(master_fd) };

    ws_writer.abort();
}

pub async fn start_terminal_server(port: u16) {
    ensure_devpts().await;

    let listener = match TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("terminal: failed to bind port {port}: {e}");
            return;
        }
    };
    println!("Terminal server listening on port {port}");

    loop {
        match listener.accept().await {
            Ok((stream, addr)) => {
                println!("terminal: connection from {addr}");
                tokio::spawn(handle_connection(stream));
            }
            Err(e) => {
                eprintln!("terminal: accept error: {e}");
            }
        }
    }
}
