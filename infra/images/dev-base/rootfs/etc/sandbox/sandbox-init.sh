#!/bin/bash
# Sandbox initialization script - runs on VM boot
# This script is executed by the init system to set up the sandbox environment

set -e

CONFIG_FILE="/etc/sandbox/config.json"
SECRETS_FILE="/etc/sandbox/secrets/.env"
START_SCRIPT="/etc/sandbox/start.sh"
LOG_DIR="/var/log/sandbox"

log() {
    echo "[sandbox-init] $(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "$LOG_DIR/init.log"
}

log "Starting sandbox initialization..."

# Run network setup if script exists (injected by manager)
if [ -f /etc/network-setup.sh ]; then
    log "Configuring network..."
    /etc/network-setup.sh
    log "Network configured"
fi

# Load secrets into environment if file exists
if [ -f "$SECRETS_FILE" ]; then
    log "Loading secrets..."
    set -a
    source "$SECRETS_FILE"
    set +a
    log "Secrets loaded"
fi

# Start SSH daemon
log "Starting SSH..."
/usr/sbin/sshd

# Start code-server as dev user
log "Starting code-server..."
su - dev -c "code-server --bind-addr 0.0.0.0:8080 --auth none --disable-telemetry > $LOG_DIR/code-server.log 2>&1 &"

# Start OpenCode server as dev user
log "Starting OpenCode server..."
su - dev -c "opencode serve --hostname 0.0.0.0 --port 3000 > $LOG_DIR/opencode.log 2>&1 &"

# Run project-specific start commands if they exist
if [ -f "$START_SCRIPT" ]; then
    log "Running start commands..."
    chmod +x "$START_SCRIPT"
    su - dev -c "cd /home/dev/workspace && $START_SCRIPT > $LOG_DIR/start.log 2>&1 &"
    log "Start commands executed"
fi

# Start sandbox-agent if it exists
if command -v sandbox-agent &> /dev/null; then
    log "Starting sandbox-agent..."
    sandbox-agent > "$LOG_DIR/agent.log" 2>&1 &
fi

log "Sandbox initialization complete"

# Keep the init script running
exec /bin/bash
