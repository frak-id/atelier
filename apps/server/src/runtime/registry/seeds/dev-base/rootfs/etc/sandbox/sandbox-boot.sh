#!/bin/sh
# Sandbox boot script — K8s entrypoint for Kata Container pods.
#
# The PVC mounts at /data (not /home/dev — see
# docs/proposals/toolset-overlay-squashfs.md §3). /home/dev itself is a bare,
# empty mountpoint until the agent's `materialize` (crate::toolset) assembles
# it as a SINGLE overlay (skel + any toolset squashfs lowers, upper/work on
# `/data`) — this script does NOT mount a base overlay. That single-assembly
# design (no base-overlay-then-remount) is deliberate: it removes the
# umount/remount race a two-step mount would have against an early SSH
# session (§5/§11 of the design doc) by construction — nothing can hold
# `/home/dev` busy before materialize runs, because nothing touches it before
# materialize runs.
#
# The handshake: this script starts the agent immediately, stages the SSH
# authorized_keys directly into the overlay's future upperdir (so it appears
# at /home/dev/.ssh once the agent's overlay is live — a lowerdir-only mount
# never touches the upper), then WAITS for the agent to signal
# /run/home-ready before starting sshd. This guarantees no SSH session can
# ever observe (or hold busy) a not-yet-assembled /home/dev.

mkdir -p /data/upper /data/work /data/toolsets

# The overlay surfaces /data/upper's OWN uid/gid as the merged /home/dev root
# (the upperdir is the merged root's inode). Created root-owned, `dev` could
# not create top-level entries in its own home (git clone of workspace/,
# ~/.bash_history, any new dotfile -> EACCES). Chown the upper root only
# (NOT -R: copied-up content must keep its own ownership) so /home/dev is
# dev-owned. The agent re-asserts this on every assembly too; doing it here
# covers the window before the agent's first materialize.
chown 1000:1000 /data/upper

# ── Loop devices for squashfs toolset mounts ──────────────────────────
# The agent loop-mounts each toolset squashfs blob (crate::toolset). `mount -o
# loop` needs /dev/loop-control to allocate a device plus /dev/loopN nodes; a
# Kata container's /dev may not have them. Create them up front (idempotent,
# needs only CAP_MKNOD from the default set) so the first materialize's mount
# does not fail with "could not set up loop device".
[ -e /dev/loop-control ] || mknod /dev/loop-control c 10 237
i=0
while [ "$i" -lt 8 ]; do
    [ -e "/dev/loop$i" ] || mknod "/dev/loop$i" b 7 "$i"
    i=$((i + 1))
done

# ── SSH key staging ───────────────────────────────────────────────────
# The sshpiper public key is mounted by K8s from the atelier-ssh-pipe-key
# Secret. Write it into the overlay upperdir now — /home/dev isn't mounted
# yet, but /data/upper IS what /home/dev/.ssh resolves to once the agent's
# overlay goes live, so this is available immediately without waiting.
SSH_KEY_MOUNT="/etc/sandbox/ssh/authorized_keys"
if [ -f "$SSH_KEY_MOUNT" ]; then
    mkdir -p /data/upper/.ssh
    cp "$SSH_KEY_MOUNT" /data/upper/.ssh/authorized_keys
    chmod 700 /data/upper/.ssh
    chmod 600 /data/upper/.ssh/authorized_keys
    chown -R 1000:1000 /data/upper/.ssh
fi

# Keep this shell as PID 1: orphaned grandchildren reparent here and get
# reaped by the shell's wait machinery, instead of being stolen mid-flight
# from the agent's tokio runtime (which owns its direct children's exit
# statuses — a waitpid(-1) reaper inside the agent corrupts exec results).
/usr/local/bin/sandbox-agent "$@" &
AGENT_PID=$!

# ── Wait for the agent to assemble /home/dev, then start sshd ──────────
# The agent's `materialize` call (run on every boot, even with zero toolsets
# — see boot.ts) writes /run/home-ready as its last step once /home/dev is a
# fully-assembled overlay, or /run/home-failed if assembly fails. Wait for
# EITHER: on success sshd serves the real home; on failure start sshd anyway
# (onto the degraded home) so the pod is reachable for diagnosis. The cap is
# ~600s to match the agent's BUILD_TIMEOUT_MS — a slow first cold pull must
# not be cut off and served the wrong (bare, un-assembled) home mid-assembly,
# which would strand any early writes on the rootfs.
i=0
while [ ! -e /run/home-ready ] && [ ! -e /run/home-failed ] && [ "$i" -lt 1200 ]; do
    sleep 0.5
    i=$((i + 1))
done

if [ -f "$SSH_KEY_MOUNT" ]; then
    # sshd StrictModes rejects authorized_keys when the home directory is
    # group/other-writable — the overlay upperdir may leave /home/dev
    # world-writable.
    chmod 755 /home/dev
    mkdir -p /run/sshd
    /usr/sbin/sshd
fi

trap 'kill -TERM "$AGENT_PID" 2>/dev/null' TERM INT

# `wait` returns early when a trapped signal arrives; loop until the agent
# itself is gone so its real exit status is propagated.
while kill -0 "$AGENT_PID" 2>/dev/null; do
    wait "$AGENT_PID"
    AGENT_STATUS=$?
done
exit "${AGENT_STATUS:-0}"
