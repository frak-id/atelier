#!/bin/sh
# Sandbox boot script — K8s entrypoint for Kata Container pods.
#
# The workspace PVC is attached as a RAW BLOCK device and this script formats
# (first boot) + mounts it at /data — not at /home/dev (see
# docs/proposals/toolset-overlay-squashfs.md §3 and
# docs/plans/toolset-inplace-update-fix-options.md §3). /home/dev itself is a bare,
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

# ── Format + mount the workspace block device at /data ─────────────────
# The workspace PVC is attached as a RAW BLOCK device (volumeMode: Block; under
# Kata it appears as a virtio-blk node at DATA_DEVICE), NOT a pre-mounted
# filesystem. Format it ext4 on first boot and mount it at /data so overlayfs
# gets a real trusted.overlay.*-capable upper (no virtio-fs userxattr shim).
# Idempotent and resume-safe: mkfs only runs when the device has no filesystem
# (blkid probe), so a resumed disk (already ext4, carrying upper/work/toolsets
# from the pause snapshot) is mounted as-is, never reformatted. A no-op when
# /data is already a mountpoint (the Docker backend bind-mounts a real ext4
# named volume there directly, so there is no block device to format).
# mkfs/mount failures MUST abort the boot: this script has no `set -e`, so an
# unchecked failure would fall through to assemble /home/dev on the ephemeral
# container rootfs — the pod would look healthy while every write silently
# bypassed the PVC and was lost on pod deletion. Check each step and exit 1
# (with diagnostics) instead. The wait-loop below then never runs; the pod
# crash-loops visibly rather than corrupting state.
DATA_DEVICE="/dev/atelier-data"
if ! mountpoint -q /data; then
    if [ -b "$DATA_DEVICE" ]; then
        if ! blkid "$DATA_DEVICE" >/dev/null 2>&1; then
            # Unformatted (fresh PVC): lazy init keeps first boot fast; the
            # metadata_csum default gives a journaled, crash-consistent fs so
            # the pause `sync` + block VolumeSnapshot stays recoverable. NOT
            # `-q`: log the format so an unexpected reformat (which would mean
            # data loss on what should be an existing disk) is auditable.
            echo "sandbox-boot: formatting fresh workspace device $DATA_DEVICE as ext4" >&2
            if ! mkfs.ext4 -F -L atelier-data "$DATA_DEVICE"; then
                echo "sandbox-boot: mkfs.ext4 failed on $DATA_DEVICE" >&2
                lsblk 2>/dev/null >&2 || true
                exit 1
            fi
        fi
        mkdir -p /data
        if ! mount -t ext4 "$DATA_DEVICE" /data; then
            echo "sandbox-boot: failed to mount $DATA_DEVICE at /data" >&2
            blkid "$DATA_DEVICE" 2>/dev/null >&2 || true
            lsblk 2>/dev/null >&2 || true
            exit 1
        fi
    else
        # No block device and /data not mounted: nothing backs the workspace.
        # Fail loud rather than silently assembling home on the ephemeral
        # rootfs (which would divorce every write from the PVC). Dump the
        # device list so a wrong devicePath is diagnosable at a glance.
        echo "sandbox-boot: workspace block device $DATA_DEVICE missing and /data not mounted" >&2
        lsblk 2>/dev/null >&2 || true
        ls -l /dev 2>/dev/null | grep -iE 'vd|atelier|disk' >&2 || true
        exit 1
    fi
fi

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
# (onto the degraded home) so the pod is reachable for diagnosis. The agent
# bounds its WHOLE pull/mount/assembly loop (any toolset count) to a single
# global ~600s deadline (toolset::BUILD_TIMEOUT_MS) and fails fast past it —
# see toolset.rs materialize_inner — so this cap only needs a small margin
# above that, not a per-toolset multiple. 1260 * 0.5s = 630s, matching
# agent.client.ts's MATERIALIZE_TOOLSETS_TIMEOUT_MS (both downstream of the
# same agent ceiling). A slow first cold pull must not be cut off and served
# the wrong (bare, un-assembled) home mid-assembly, which would strand any
# early writes on the rootfs.
i=0
while [ ! -e /run/home-ready ] && [ ! -e /run/home-failed ] && [ "$i" -lt 1260 ]; do
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
