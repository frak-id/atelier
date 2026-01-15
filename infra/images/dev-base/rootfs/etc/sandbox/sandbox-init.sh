#!/bin/bash
# Sandbox init script - runs as PID 1 in Firecracker VM

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/dev/.bun/bin
export HOME=/root
export BUN_INSTALL=/home/dev/.bun

CONFIG_FILE="/etc/sandbox/config.json"
SECRETS_FILE="/etc/sandbox/secrets/.env"
START_SCRIPT="/etc/sandbox/start.sh"
LOG_DIR="/var/log/sandbox"

mkdir -p "$LOG_DIR"

log() {
    echo "[init] $(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "$LOG_DIR/init.log"
}

log "Starting sandbox init (PID $$)"
log "PATH=$PATH"

log "Mounting filesystems..."
mount -t proc proc /proc 2>&1 | tee -a "$LOG_DIR/init.log"
mount -t sysfs sys /sys 2>&1 | tee -a "$LOG_DIR/init.log"
mount -t devtmpfs dev /dev 2>/dev/null || mount -t tmpfs dev /dev
mkdir -p /dev/pts /dev/shm
mount -t devpts devpts /dev/pts 2>&1 | tee -a "$LOG_DIR/init.log"
mount -t tmpfs tmpfs /dev/shm 2>&1 | tee -a "$LOG_DIR/init.log"
mount -t tmpfs tmpfs /run 2>&1 | tee -a "$LOG_DIR/init.log"
mount -t tmpfs tmpfs /tmp 2>&1 | tee -a "$LOG_DIR/init.log"

log "Setting up hostname..."
if [ -f "$CONFIG_FILE" ]; then
    SANDBOX_ID=$(cat "$CONFIG_FILE" | grep -o '"sandboxId"[[:space:]]*:[[:space:]]*"[^"]*"' | cut -d'"' -f4)
    if [ -n "$SANDBOX_ID" ]; then
        hostname "sandbox-$SANDBOX_ID"
        echo "sandbox-$SANDBOX_ID" > /etc/hostname
        log "Hostname set to sandbox-$SANDBOX_ID"
    fi
fi

log "Configuring network..."
if [ -f /etc/network-setup.sh ]; then
    chmod +x /etc/network-setup.sh
    /etc/network-setup.sh 2>&1 | tee -a "$LOG_DIR/init.log"
    log "Network configured"
else
    log "WARNING: No network-setup.sh found"
fi

if [ -f "$SECRETS_FILE" ]; then
    log "Loading secrets..."
    set -a
    source "$SECRETS_FILE"
    set +a
fi

log "Starting SSH daemon..."
mkdir -p /run/sshd
chmod 0755 /run/sshd
if [ -x /usr/sbin/sshd ]; then
    /usr/sbin/sshd -D &
    log "SSH daemon started (PID $!)"
else
    log "ERROR: sshd not found"
fi

log "Starting code-server..."
if command -v code-server >/dev/null 2>&1; then
    su - dev -c "code-server --bind-addr 0.0.0.0:8080 --auth none --disable-telemetry > $LOG_DIR/code-server.log 2>&1" &
    log "code-server started (PID $!)"
else
    log "ERROR: code-server not found"
fi

log "Starting OpenCode server..."
if [ -x /usr/bin/opencode ] || command -v opencode >/dev/null 2>&1; then
    su - dev -c "opencode serve --hostname 0.0.0.0 --port 3000 > $LOG_DIR/opencode.log 2>&1" &
    log "OpenCode started (PID $!)"
else
    log "WARNING: opencode not found in PATH"
    # Try to find it
    if [ -f /usr/lib/node_modules/opencode-ai/bin/opencode ]; then
        log "Found opencode at /usr/lib/node_modules/opencode-ai/bin/opencode"
        su - dev -c "/usr/lib/node_modules/opencode-ai/bin/opencode serve --hostname 0.0.0.0 --port 3000 > $LOG_DIR/opencode.log 2>&1" &
    fi
fi

log "Starting sandbox-agent..."
if [ -f /usr/local/lib/sandbox-agent.mjs ]; then
    node /usr/local/lib/sandbox-agent.mjs > "$LOG_DIR/agent.log" 2>&1 &
    log "sandbox-agent started (PID $!)"
else
    log "ERROR: sandbox-agent.mjs not found"
    ls -la /usr/local/lib/ 2>&1 | tee -a "$LOG_DIR/init.log"
fi

if [ -f "$START_SCRIPT" ]; then
    log "Running start commands..."
    chmod +x "$START_SCRIPT"
    su - dev -c "cd /home/dev/workspace && $START_SCRIPT > $LOG_DIR/start.log 2>&1" &
fi

log "Sandbox initialization complete"
log "Services: SSH(22), code-server(8080), opencode(3000), agent(9999)"

# List running processes
log "Running processes:"
ps aux 2>&1 | tee -a "$LOG_DIR/init.log"

# PID 1 must stay alive - reap zombies and wait
while true; do
    sleep 60 &
    wait $!
done
