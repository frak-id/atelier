#!/bin/bash
# Sandbox init script - runs as PID 1 in Firecracker VM

export PATH=/opt/shared/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/dev/.bun/bin
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

# Read config values using jq
if [ -f "$CONFIG_FILE" ]; then
    NFS_HOST=$(jq -r '.network.nfsHost // empty' "$CONFIG_FILE" 2>/dev/null)
    DASHBOARD_DOMAIN=$(jq -r '.network.dashboardDomain // empty' "$CONFIG_FILE" 2>/dev/null)
    VSCODE_PORT=$(jq -r '.services.vscode.port // empty' "$CONFIG_FILE" 2>/dev/null)
    OPENCODE_PORT=$(jq -r '.services.opencode.port // empty' "$CONFIG_FILE" 2>/dev/null)
    TERMINAL_PORT=$(jq -r '.services.terminal.port // empty' "$CONFIG_FILE" 2>/dev/null)
    AGENT_PORT=$(jq -r '.services.agent.port // empty' "$CONFIG_FILE" 2>/dev/null)
fi
NFS_HOST="${NFS_HOST:-172.16.0.1}"
DASHBOARD_DOMAIN="${DASHBOARD_DOMAIN:-sandbox-dash.localhost}"
VSCODE_PORT="${VSCODE_PORT:-8080}"
OPENCODE_PORT="${OPENCODE_PORT:-3000}"
TERMINAL_PORT="${TERMINAL_PORT:-7681}"
AGENT_PORT="${AGENT_PORT:-9999}"
NFS_CACHE_EXPORT="/var/lib/sandbox/shared-cache"
NFS_CACHE_MOUNT="/mnt/cache"
NFS_BINARIES_EXPORT="/var/lib/sandbox/shared-binaries"
NFS_BINARIES_MOUNT="/opt/shared"
NFS_CONFIGS_EXPORT="/var/lib/sandbox/shared-configs"
NFS_CONFIGS_MOUNT="/mnt/configs"
NFS_AUTH_EXPORT="/var/lib/sandbox/shared-auth"
NFS_AUTH_MOUNT="/mnt/auth"

log "Creating device nodes..."
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

log "Configuring network..."
if [ -f /etc/network-setup.sh ]; then
    chmod +x /etc/network-setup.sh
    /etc/network-setup.sh 2>&1 | tee -a "$LOG_DIR/init.log"
    log "Network configured"
else
    log "WARNING: No network-setup.sh found"
fi

log "Mounting NFS shared cache..."
mkdir -p "$NFS_CACHE_MOUNT"
if timeout 5 mount -t nfs -o vers=4,noatime,nodiratime,soft,timeo=10,retrans=1 "$NFS_HOST:$NFS_CACHE_EXPORT" "$NFS_CACHE_MOUNT" 2>&1 | tee -a "$LOG_DIR/init.log"; then
    log "NFS cache mounted at $NFS_CACHE_MOUNT"
    
    mkdir -p /home/dev/.bun/install
    mkdir -p /home/dev/.npm
    mkdir -p /home/dev/.cache/pip
    
    if [ ! -L /home/dev/.bun/install/cache ]; then
        rm -rf /home/dev/.bun/install/cache 2>/dev/null
        ln -sf "$NFS_CACHE_MOUNT/bun" /home/dev/.bun/install/cache
        log "Linked bun cache -> $NFS_CACHE_MOUNT/bun"
    fi
    
    # Configure bun to use copyfile backend (hardlinks don't work across NFS)
    mkdir -p /home/dev/.bunfig
    cat > /home/dev/.bunfig.toml << 'BUNFIG'
[install]
backend = "copyfile"
BUNFIG
    chown dev:dev /home/dev/.bunfig.toml
    
    if [ ! -L /home/dev/.npm/_cacache ]; then
        mkdir -p /home/dev/.npm
        rm -rf /home/dev/.npm/_cacache 2>/dev/null
        ln -sf "$NFS_CACHE_MOUNT/npm" /home/dev/.npm/_cacache
        log "Linked npm cache -> $NFS_CACHE_MOUNT/npm"
    fi
    
    if [ ! -L /home/dev/.cache/pip ]; then
        mkdir -p /home/dev/.cache
        rm -rf /home/dev/.cache/pip 2>/dev/null
        ln -sf "$NFS_CACHE_MOUNT/pip" /home/dev/.cache/pip
        log "Linked pip cache -> $NFS_CACHE_MOUNT/pip"
    fi
    
    chown -R dev:dev /home/dev/.bun /home/dev/.npm /home/dev/.cache 2>/dev/null
else
    log "WARNING: Failed to mount NFS cache, package caching disabled"
fi

log "Mounting NFS shared binaries..."
mkdir -p "$NFS_BINARIES_MOUNT"
if timeout 5 mount -t nfs -o vers=4,ro,noatime,nodiratime,soft,timeo=10,retrans=1 "$NFS_HOST:$NFS_BINARIES_EXPORT" "$NFS_BINARIES_MOUNT" 2>&1 | tee -a "$LOG_DIR/init.log"; then
    log "NFS binaries mounted at $NFS_BINARIES_MOUNT (read-only)"
    export PATH="$NFS_BINARIES_MOUNT/bin:$PATH"
    echo "export PATH=$NFS_BINARIES_MOUNT/bin:\$PATH" >> /home/dev/.profile
    log "Added $NFS_BINARIES_MOUNT/bin to PATH"
else
    log "WARNING: Failed to mount NFS binaries"
fi

log "Mounting NFS shared configs..."
mkdir -p "$NFS_CONFIGS_MOUNT"
if timeout 5 mount -t nfs -o vers=4,ro,noatime,nodiratime,soft,timeo=10,retrans=1 "$NFS_HOST:$NFS_CONFIGS_EXPORT" "$NFS_CONFIGS_MOUNT" 2>&1 | tee -a "$LOG_DIR/init.log"; then
    log "NFS configs mounted at $NFS_CONFIGS_MOUNT (read-only)"
    
    WORKSPACE_ID=""
    if [ -f "$CONFIG_FILE" ]; then
        WORKSPACE_ID=$(jq -r '.workspaceId // empty' "$CONFIG_FILE" 2>/dev/null)
    fi
    
    mkdir -p /home/dev/.config/opencode
    mkdir -p /home/dev/.local/share/code-server/User
    
    link_config() {
        local src="$1"
        local dest="$2"
        if [ -f "$src" ]; then
            rm -f "$dest" 2>/dev/null
            ln -sf "$src" "$dest"
            log "Linked $dest -> $src"
        fi
    }
    
    link_config "$NFS_CONFIGS_MOUNT/global/home/dev/.config/opencode/opencode.json" "/home/dev/.config/opencode/opencode.json"
    link_config "$NFS_CONFIGS_MOUNT/global/home/dev/.local/share/code-server/User/settings.json" "/home/dev/.local/share/code-server/User/settings.json"
    
    if [ -n "$WORKSPACE_ID" ]; then
        WS_CONFIG_DIR="$NFS_CONFIGS_MOUNT/workspaces/$WORKSPACE_ID"
        if [ -d "$WS_CONFIG_DIR" ]; then
            log "Found workspace configs at $WS_CONFIG_DIR"
            if [ -f "$WS_CONFIG_DIR/home/dev/.config/opencode/opencode.json" ]; then
                link_config "$WS_CONFIG_DIR/home/dev/.config/opencode/opencode.json" "/home/dev/.config/opencode/opencode.json"
            fi
        fi
    fi
    
    chown -R dev:dev /home/dev/.config /home/dev/.local 2>/dev/null
else
    log "WARNING: Failed to mount NFS configs"
fi

log "Mounting NFS shared auth..."
mkdir -p "$NFS_AUTH_MOUNT"
if timeout 5 mount -t nfs -o vers=4,noatime,nodiratime,soft,timeo=10,retrans=1 "$NFS_HOST:$NFS_AUTH_EXPORT" "$NFS_AUTH_MOUNT" 2>&1 | tee -a "$LOG_DIR/init.log"; then
    log "NFS auth mounted at $NFS_AUTH_MOUNT (read-write)"
    
    mkdir -p /home/dev/.local/share/opencode
    mkdir -p /home/dev/.config/opencode
    
    link_config "$NFS_AUTH_MOUNT/opencode.json" "/home/dev/.local/share/opencode/auth.json"
    link_config "$NFS_AUTH_MOUNT/antigravity.json" "/home/dev/.config/opencode/antigravity-accounts.json"
    
    chown -h dev:dev /home/dev/.local/share/opencode/auth.json /home/dev/.config/opencode/antigravity-accounts.json 2>/dev/null
else
    log "WARNING: Failed to mount NFS auth"
fi

if [ -f "$SECRETS_FILE" ]; then
    log "Loading secrets..."
    set -a
    source "$SECRETS_FILE"
    set +a
fi

# Start sandbox-agent FIRST for fast boot detection by manager
log "Starting sandbox-agent..."
if [ -f /usr/local/lib/sandbox-agent.mjs ]; then
    node /usr/local/lib/sandbox-agent.mjs > "$LOG_DIR/agent.log" 2>&1 &
    log "sandbox-agent started (PID $!)"
else
    log "ERROR: sandbox-agent.mjs not found"
    ls -la /usr/local/lib/ 2>&1 | tee -a "$LOG_DIR/init.log"
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

log "Starting code-server..."
if command -v code-server >/dev/null 2>&1; then
    su - dev -c "code-server --bind-addr 0.0.0.0:$VSCODE_PORT --auth none --disable-telemetry $WORKSPACE_DIR > $LOG_DIR/code-server.log 2>&1" &
    CODE_SERVER_PID=$!
    log "code-server started (PID $CODE_SERVER_PID) with workspace $WORKSPACE_DIR"
    
    EXTENSIONS_FILE="/etc/sandbox/vscode-extensions.json"
    if [ -f "$EXTENSIONS_FILE" ]; then
        log "Installing VSCode extensions in background..."
        (
            sleep 10
            EXTENSIONS=$(cat "$EXTENSIONS_FILE" | tr -d '[]"' | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -v '^$')
            for ext in $EXTENSIONS; do
                log "Installing extension: $ext"
                su - dev -c "code-server --install-extension $ext" >> "$LOG_DIR/extensions.log" 2>&1 || true
            done
            log "Extension installation complete"
        ) &
    fi
else
    log "ERROR: code-server not found"
fi

# Pre-install OpenCode plugin SDK (required for external plugins with standalone binary)
if command -v opencode >/dev/null 2>&1; then
    OPENCODE_PLUGIN_DIR="/home/dev/.cache/opencode"
    if [ ! -d "$OPENCODE_PLUGIN_DIR/node_modules/@opencode-ai/plugin" ]; then
        log "Installing OpenCode plugin SDK..."
        mkdir -p "$OPENCODE_PLUGIN_DIR"
        chown dev:dev "$OPENCODE_PLUGIN_DIR"
        su - dev -c "cd $OPENCODE_PLUGIN_DIR && bun add @opencode-ai/plugin 2>&1" | tee -a "$LOG_DIR/init.log"
        log "OpenCode plugin SDK installed"
    fi
fi

log "Starting OpenCode server..."
OPENCODE_CORS="--cors https://${DASHBOARD_DOMAIN}"
if [ -x /usr/bin/opencode ] || command -v opencode >/dev/null 2>&1; then
    su - dev -c "cd $WORKSPACE_DIR && opencode serve --hostname 0.0.0.0 --port $OPENCODE_PORT $OPENCODE_CORS > $LOG_DIR/opencode.log 2>&1" &
    log "OpenCode started (PID $!) in $WORKSPACE_DIR with CORS enabled"
else
    log "WARNING: opencode not found in PATH"
    if [ -f /usr/lib/node_modules/opencode-ai/bin/opencode ]; then
        log "Found opencode at /usr/lib/node_modules/opencode-ai/bin/opencode"
        su - dev -c "cd $WORKSPACE_DIR && /usr/lib/node_modules/opencode-ai/bin/opencode serve --hostname 0.0.0.0 --port $OPENCODE_PORT $OPENCODE_CORS > $LOG_DIR/opencode.log 2>&1" &
    fi
fi

log "Starting ttyd terminal server..."
if command -v ttyd >/dev/null 2>&1; then
    # Run ttyd as dev user with login shell for full environment
    ttyd -p $TERMINAL_PORT -W -t fontSize=14 -t fontFamily="monospace" su - dev > "$LOG_DIR/ttyd.log" 2>&1 &
    log "ttyd started (PID $!) on port $TERMINAL_PORT"
else
    log "WARNING: ttyd not found"
fi

if [ -f "$START_SCRIPT" ]; then
    log "Running start commands..."
    chmod +x "$START_SCRIPT"
    su - dev -c "cd /home/dev/workspace && $START_SCRIPT > $LOG_DIR/start.log 2>&1" &
fi

log "Sandbox initialization complete"
log "Services: SSH(22), code-server($VSCODE_PORT), opencode($OPENCODE_PORT), ttyd($TERMINAL_PORT), agent($AGENT_PORT)"

# List running processes
log "Running processes:"
ps aux 2>&1 | tee -a "$LOG_DIR/init.log"

# PID 1 must stay alive - reap zombies and wait
while true; do
    sleep 60 &
    wait $!
done
