#!/bin/bash
# Sandbox init script - runs as PID 1 in Firecracker VM

export PATH=/opt/shared/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/dev/.bun/bin
export HOME=/root
export BUN_INSTALL=/home/dev/.bun

CONFIG_FILE="/etc/sandbox/config.json"
SECRETS_FILE="/etc/sandbox/secrets/.env"
LOG_DIR="/var/log/sandbox"

mkdir -p "$LOG_DIR"

log() {
    echo "[init] $(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG_DIR/init.log"
}

log "Starting sandbox init (PID $$)"
log "PATH=$PATH"

log "Mounting filesystems..."
mount -t proc proc /proc >> "$LOG_DIR/init.log" 2>&1
mount -t sysfs sys /sys >> "$LOG_DIR/init.log" 2>&1
mount -t devtmpfs dev /dev 2>/dev/null || mount -t tmpfs dev /dev
mkdir -p /dev/pts /dev/shm
mount -t devpts devpts /dev/pts >> "$LOG_DIR/init.log" 2>&1
mount -t tmpfs tmpfs /dev/shm >> "$LOG_DIR/init.log" 2>&1
mount -t tmpfs tmpfs /run >> "$LOG_DIR/init.log" 2>&1
mount -t tmpfs tmpfs /tmp >> "$LOG_DIR/init.log" 2>&1

# Read config values using jq
if [ -f "$CONFIG_FILE" ]; then
    DASHBOARD_DOMAIN=$(jq -r '.network.dashboardDomain // empty' "$CONFIG_FILE" 2>/dev/null)
    AGENT_PORT=$(jq -r '.services.agent.port // empty' "$CONFIG_FILE" 2>/dev/null)
fi
DASHBOARD_DOMAIN="${DASHBOARD_DOMAIN:-sandbox-dash.localhost}"
AGENT_PORT="${AGENT_PORT:-9999}"

log "Creating device nodes..."
rm -f /dev/null /dev/zero /dev/random /dev/urandom /dev/tty /dev/console /dev/ptmx 2>/dev/null
mknod -m 666 /dev/null c 1 3
mknod -m 666 /dev/zero c 1 5
mknod -m 666 /dev/random c 1 8
mknod -m 666 /dev/urandom c 1 9
mknod -m 666 /dev/tty c 5 0
mknod -m 600 /dev/console c 5 1
mknod -m 666 /dev/ptmx c 5 2
mknod -m 666 /dev/vsock c 10 123
ln -sf /proc/self/fd /dev/fd 2>/dev/null
ln -sf /proc/self/fd/0 /dev/stdin 2>/dev/null
ln -sf /proc/self/fd/1 /dev/stdout 2>/dev/null
ln -sf /proc/self/fd/2 /dev/stderr 2>/dev/null

mknod -m 444 /dev/vdb b 254 16 2>/dev/null
if [ -b /dev/vdb ]; then
    log "Mounting shared binaries drive..."
    mkdir -p /opt/shared
    mount -o ro /dev/vdb /opt/shared >> "$LOG_DIR/init.log" 2>&1
    log "Shared binaries mounted at /opt/shared"
else
    log "No shared binaries drive found (/dev/vdb)"
fi

log "Setting up hostname and hosts file..."
if [ -f "$CONFIG_FILE" ]; then
    SANDBOX_ID=$(jq -r '.sandboxId // empty' "$CONFIG_FILE" 2>/dev/null)
    if [ -n "$SANDBOX_ID" ]; then
        hostname "sandbox-$SANDBOX_ID"
        echo "sandbox-$SANDBOX_ID" > /etc/hostname
        log "Hostname set to sandbox-$SANDBOX_ID"
    fi
fi

# Create /etc/hosts (not included in Docker export)
cat > /etc/hosts << 'EOF'
127.0.0.1	localhost
::1		localhost ip6-localhost ip6-loopback
EOF
log "Created /etc/hosts"

# Network is configured by the manager post-boot via agent exec
# This allows the same init script to work for both fresh spawns and snapshot restores
log "Network will be configured by manager after agent ready"

link_config() {
    local src="$1"
    local dest="$2"
    if [ -f "$src" ]; then
        rm -f "$dest" 2>/dev/null
        ln -sf "$src" "$dest"
        log "Linked $dest -> $src"
    fi
}

if [ -f "$SECRETS_FILE" ]; then
    log "Loading secrets..."
    set -a
    source "$SECRETS_FILE"
    set +a
fi

# Start sandbox-agent FIRST for fast boot detection by manager
log "Starting sandbox-agent..."
if [ -x /usr/local/bin/sandbox-agent ]; then
    /usr/local/bin/sandbox-agent > "$LOG_DIR/agent.log" 2>&1 &
    log "sandbox-agent started (PID $!)"
else
    log "ERROR: sandbox-agent binary not found"
    ls -la /usr/local/bin/sandbox-agent >> "$LOG_DIR/init.log" 2>&1
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

WORKSPACE_DIR_FILE="/etc/sandbox/workspace-dir"
if [ -f "$WORKSPACE_DIR_FILE" ]; then
    WORKSPACE_DIR=$(cat "$WORKSPACE_DIR_FILE")
else
    WORKSPACE_DIR="/home/dev/workspace"
fi
log "Workspace directory: $WORKSPACE_DIR"

log "Sandbox initialization complete"
log "Services: SSH(22), agent($AGENT_PORT) — other services managed by agent via config"

# List running processes
log "Running processes:"
ps aux >> "$LOG_DIR/init.log" 2>&1

# PID 1 must stay alive - reap zombies and wait
while true; do
    sleep 60 &
    wait $!
done
