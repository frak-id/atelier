#!/bin/bash
# Sandbox init script - runs as PID 1 inside Kata Containers VM
#
# Boot-time is critical — the host blocks on waitForAgent until the agent
# responds to a health check over TCP.  Structure:
#   Phase 1: Minimal mounts + device nodes (required for agent + exec)
#   Phase 2: Start agent immediately (host can begin talking)
#   Phase 3: Non-critical setup (/etc/hosts, SSH)

export PATH=/opt/shared/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/dev/.bun/bin
export HOME=/root
export BUN_INSTALL=/home/dev/.bun

LOG_DIR="/var/log/sandbox"

mkdir -p "$LOG_DIR"

# Log with ms-precision timing relative to kernel boot (/proc/uptime).
# Falls back to "?" before /proc is mounted.
log() {
    local up
    read -r up _ < /proc/uptime 2>/dev/null || up="?"
    echo "[init] +${up}s $1" >> "$LOG_DIR/init.log"
}

# ── Phase 1: Minimal mounts + devices (needed by agent and host exec) ─

mount -t proc proc /proc
log "Starting sandbox init (PID $$)"

mount -t sysfs sys /sys
mount -t devtmpfs dev /dev 2>/dev/null || mount -t tmpfs dev /dev
mkdir -p /dev/pts /dev/shm
mount -t devpts devpts /dev/pts
mount -t tmpfs tmpfs /dev/shm
mount -t tmpfs tmpfs /run
mount -t tmpfs tmpfs /tmp
log "Filesystems mounted"

rm -f /dev/null /dev/zero /dev/random /dev/urandom /dev/tty /dev/console /dev/ptmx 2>/dev/null
mknod -m 666 /dev/null c 1 3
mknod -m 666 /dev/zero c 1 5
mknod -m 666 /dev/random c 1 8
mknod -m 666 /dev/urandom c 1 9
mknod -m 666 /dev/tty c 5 0
mknod -m 600 /dev/console c 5 1
mknod -m 666 /dev/ptmx c 5 2
ln -sf /proc/self/fd /dev/fd 2>/dev/null
ln -sf /proc/self/fd/0 /dev/stdin 2>/dev/null
ln -sf /proc/self/fd/1 /dev/stdout 2>/dev/null
ln -sf /proc/self/fd/2 /dev/stderr 2>/dev/null
log "Device nodes created"

mknod -m 444 /dev/vdb b 254 16 2>/dev/null
if [ -b /dev/vdb ]; then
    mkdir -p /opt/shared
    mount -o ro /dev/vdb /opt/shared
    log "Shared binaries mounted at /opt/shared"
else
    log "No shared binaries drive found (/dev/vdb)"
fi

# ── Phase 1b: Bootstrap /home/dev from skeleton if PVC is empty ───────
# When a fresh PVC is mounted at /home/dev (no prebuild), the image
# contents are hidden.  Restore dotfiles, .bun, etc. from the tarball
# created at image build time.
SKEL_TARBALL="/etc/skel/home-dev.tar.gz"
if [ -f "$SKEL_TARBALL" ] && [ ! -d "/home/dev/.bun" ]; then
    log "Empty home detected — extracting skeleton"
    tar xzf "$SKEL_TARBALL" -C /home/dev
    chown -R 1000:1000 /home/dev
    log "Skeleton extracted"
fi

# ── Phase 2: Start agent IMMEDIATELY ──────────────────────────────────
# Agent only needs basic fs.  Everything above is sufficient.
# Host-side waitForAgent polls health over TCP — respond ASAP.

log "Starting sandbox-agent"
if [ -x /usr/local/bin/sandbox-agent ]; then
    # Supervision loop for sandbox-agent with auto-restart and backoff
    (
        HEARTBEAT_FILE="/run/sandbox-agent.heartbeat"
        AGENT_LOG="$LOG_DIR/agent.log"
        AGENT_LOG_MAX_BYTES=$((2 * 1024 * 1024))
        AGENT_LOG_KEEP=5
        HEARTBEAT_STALE_SECS=30
        HEARTBEAT_GRACE_SECS=15

        rotate_log_copytruncate() {
            local file="$1"
            local max_bytes="$2"
            local keep="$3"

            [ -f "$file" ] || return 0

            local size
            size=$(stat -c%s "$file" 2>/dev/null || echo 0)
            if [ "$size" -lt "$max_bytes" ]; then
                return 0
            fi

            # Shift older logs
            local i
            for i in $(seq "$keep" -1 2); do
                if [ -f "${file}.$((i - 1))" ]; then
                    mv -f "${file}.$((i - 1))" "${file}.${i}" 2>/dev/null || true
                fi
            done

            cp -f "$file" "${file}.1" 2>/dev/null || true
            : > "$file" 2>/dev/null || true
            log "Rotated $file (>${max_bytes} bytes)"
        }

        restart_times=()
        while true; do
            rm -f "$HEARTBEAT_FILE" 2>/dev/null || true

            /usr/local/bin/sandbox-agent >> "$AGENT_LOG" 2>&1 &
            agent_pid=$!
            start_time=$(date +%s)

            # While agent is running, rotate logs and detect hangs via heartbeat.
            while kill -0 "$agent_pid" 2>/dev/null; do
                rotate_log_copytruncate "$AGENT_LOG" "$AGENT_LOG_MAX_BYTES" "$AGENT_LOG_KEEP"

                now=$(date +%s)
                if [ -f "$HEARTBEAT_FILE" ]; then
                    hb_mtime=$(stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || echo 0)
                    hb_age=$((now - hb_mtime))
                    if [ "$hb_age" -gt "$HEARTBEAT_STALE_SECS" ]; then
                        log "WARNING: sandbox-agent heartbeat stale (${hb_age}s), killing PID ${agent_pid}"
                        kill -9 "$agent_pid" 2>/dev/null || true
                        break
                    fi
                else
                    age=$((now - start_time))
                    if [ "$age" -gt "$HEARTBEAT_GRACE_SECS" ]; then
                        log "WARNING: sandbox-agent heartbeat missing after ${age}s, killing PID ${agent_pid}"
                        kill -9 "$agent_pid" 2>/dev/null || true
                        break
                    fi
                fi

                sleep 5
            done

            wait "$agent_pid"
            exit_code=$?
            log "sandbox-agent exited with code $exit_code"

            # Track restart times (keep only last 60 seconds)
            current_time=$(date +%s)
            restart_times+=("$current_time")
            restart_times=("${restart_times[@]:(-5)}")

            # Check if we have more than 5 restarts in the last 60 seconds
            if [ ${#restart_times[@]} -ge 5 ]; then
                oldest_time=${restart_times[0]}
                time_diff=$((current_time - oldest_time))
                if [ $time_diff -lt 60 ]; then
                    log "WARNING: sandbox-agent restarted 5+ times in 60s, backing off for 30s"
                    sleep 30
                    restart_times=()
                fi
            fi

            log "Restarting sandbox-agent in 2 seconds..."
            sleep 2
        done
    ) &
    log "sandbox-agent supervision started"
else
    log "ERROR: sandbox-agent binary not found"
    ls -la /usr/local/bin/sandbox-agent >> "$LOG_DIR/init.log" 2>&1
fi

# ── Phase 3: Non-critical setup (agent already listening) ─────────────
# Everything below runs AFTER the agent is started.  The host may already
# be talking to the agent while these complete — that's fine because all
# required mounts and devices are already in place.
# NOTE: hostname, DNS, swap, secrets, and services are managed by the
# manager over TCP — only /etc/hosts and sshd belong here.

# /etc/hosts (not included in Docker export)
cat > /etc/hosts << 'EOF'
127.0.0.1	localhost
::1		localhost ip6-localhost ip6-loopback
EOF
log "Created /etc/hosts"

# SSH
log "Starting SSH daemon"
mkdir -p /run/sshd
chmod 0755 /run/sshd
if [ -x /usr/sbin/sshd ]; then
    /usr/sbin/sshd -D &
    log "SSH daemon started (PID $!)"
else
    log "ERROR: sshd not found"
fi

log "Init complete"

# List running processes
log "Running processes:"
ps aux >> "$LOG_DIR/init.log" 2>&1

# PID 1 must stay alive - reap zombies and wait
while true; do
    sleep 60 &
    wait $!
done
