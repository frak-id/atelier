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

    # Generate host keys on first boot
    [ -f /etc/ssh/ssh_host_ed25519_key ] || ssh-keygen -A 2>/dev/null

    # Start sshd as daemon (forks to background)
    mkdir -p /run/sshd
    /usr/sbin/sshd
fi

exec /usr/local/bin/sandbox-agent "$@"
