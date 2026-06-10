#!/bin/sh
# Sandbox boot script — K8s entrypoint for Kata Container pods.
#
# When a fresh PVC is mounted at /home/dev (no prebuild), the image's
# original contents are hidden.  This script restores dotfiles, .bun,
# etc. from /home/skel (populated at image build time), starts sshd,
# then hands off to the sandbox-agent.

if [ -d /home/skel ] && [ ! -d /home/dev/.bun ]; then
    cp -a /home/skel/. /home/dev/
    chown -R 1000:1000 /home/dev
fi

# ── SSH setup ─────────────────────────────────────────────────────────
# The sshpiper public key is mounted by K8s from the atelier-ssh-pipe-key
# Secret.  Copy it into ~dev/.ssh/authorized_keys so sshpiper can
# authenticate as the "dev" user when proxying SSH connections.
SSH_KEY_MOUNT="/etc/sandbox/ssh/authorized_keys"
if [ -f "$SSH_KEY_MOUNT" ]; then
    # PVC mounts may leave /home/dev world-writable; sshd StrictModes
    # rejects authorized_keys when the home directory is group/other-writable.
    chmod 755 /home/dev
    mkdir -p /home/dev/.ssh
    cp "$SSH_KEY_MOUNT" /home/dev/.ssh/authorized_keys
    chmod 700 /home/dev/.ssh
    chmod 600 /home/dev/.ssh/authorized_keys
    chown -R 1000:1000 /home/dev/.ssh

    # Host keys are baked into the image (ssh-keygen -A at build time).
    # Start sshd as daemon (forks to background)
    mkdir -p /run/sshd
    /usr/sbin/sshd
fi

# Keep this shell as PID 1: orphaned grandchildren reparent here and get
# reaped by the shell's wait machinery, instead of being stolen mid-flight
# from the agent's tokio runtime (which owns its direct children's exit
# statuses — a waitpid(-1) reaper inside the agent corrupts exec results).
/usr/local/bin/sandbox-agent "$@" &
AGENT_PID=$!

trap 'kill -TERM "$AGENT_PID" 2>/dev/null' TERM INT

# `wait` returns early when a trapped signal arrives; loop until the agent
# itself is gone so its real exit status is propagated.
while kill -0 "$AGENT_PID" 2>/dev/null; do
    wait "$AGENT_PID"
    AGENT_STATUS=$?
done
exit "${AGENT_STATUS:-0}"
