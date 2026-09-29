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
# A no-op when /data is already a mountpoint (the Docker backend bind-mounts a
# real ext4 named volume there directly, so there is no block device).
#
# mkfs guard — formatting is destructive and irreversible, so it requires
# positive proof the volume is new, not merely "blkid saw nothing". ALL of:
#   1. $ATELIER_DATA_FRESH = 1: the server sets it only when it created the
#      PVC blank in this boot (no snapshot dataSource, not a resumed PVC —
#      boot.ts `freshVolume`). A resumed or prebuild/pause-snapshot clone
#      never carries it, so those disks can never be formatted here.
#   2. `blkid -p` (low-level probe, no cache) exits EXACTLY 2 = "no
#      signature". Any other non-zero (8 = ambiguous signatures, 4 = usage/
#      probe error, 127 = missing binary) is NOT evidence of emptiness.
#   3. The first FRESH_PROBE_BYTES read back as zeros. The env var lives in the
#      pod spec, so a never-paused sandbox whose containers restart in place
#      (host reboot, kata upgrade) still has it; this content check is what
#      protects that disk: our ext4 always has its superblock at byte 1024,
#      and a fresh topolvm-thin LV reads all-zero. It also catches a device
#      that reads with errors (cmp exits 2) — blkid reports those as "2" too.
# Anything else with no recognisable filesystem REFUSES (exit 1, diagnostics,
# disk untouched): a crash-looping pod is recoverable, a wiped workspace is
# not. A disk with a signature is mounted as-is; if it isn't ext4 the mount
# fails and we exit 1 — we never format over an existing signature.
# mkfs/mount failures MUST abort the boot: this script has no `set -e`, so an
# unchecked failure would fall through to assemble /home/dev on the ephemeral
# container rootfs — the pod would look healthy while every write silently
# bypassed the PVC and was lost on pod deletion. Check each step and exit 1
# (with diagnostics) instead. The wait-loop below then never runs; the pod
# crash-loops visibly rather than corrupting state.
DATA_DEVICE="/dev/atelier-data"
FRESH_PROBE_BYTES=1048576

# Refuse to touch the device: log why plus enough state to diagnose, exit 1.
refuse_data_device() {
    echo "sandbox-boot: REFUSING to format $DATA_DEVICE: $1" >&2
    echo "sandbox-boot: disk left untouched; if it really is disposable, destroy and recreate the sandbox" >&2
    blkid -p "$DATA_DEVICE" >&2 2>&1 || true
    lsblk -o NAME,MAJ:MIN,SIZE,RO,TYPE,FSTYPE 2>/dev/null >&2 || true
    exit 1
}

if ! mountpoint -q /data; then
    if [ -b "$DATA_DEVICE" ]; then
        blkid -p "$DATA_DEVICE" >/dev/null 2>&1
        probe=$?
        case "$probe" in
            0) ;; # has a signature: mount as-is below, never reformat
            2)
                if [ "${ATELIER_DATA_FRESH:-}" != "1" ]; then
                    refuse_data_device "no filesystem found, but the server did not mark this volume as new (resumed or snapshot-cloned disk)"
                fi
                if ! cmp -s -n "$FRESH_PROBE_BYTES" "$DATA_DEVICE" /dev/zero; then
                    refuse_data_device "no filesystem found, but the first $FRESH_PROBE_BYTES bytes are not zero (or unreadable)"
                fi
                # Proven new: lazy init keeps first boot fast; the
                # metadata_csum default gives a journaled, crash-consistent fs
                # so the pause `sync` + block VolumeSnapshot stays recoverable.
                # NOT `-q`: every format is logged, so it is auditable.
                echo "sandbox-boot: formatting new workspace device $DATA_DEVICE as ext4" >&2
                if ! mkfs.ext4 -F -L atelier-data "$DATA_DEVICE"; then
                    echo "sandbox-boot: mkfs.ext4 failed on $DATA_DEVICE" >&2
                    lsblk 2>/dev/null >&2 || true
                    exit 1
                fi
                ;;
            *) refuse_data_device "blkid -p probe failed (exit $probe), cannot tell whether the disk holds data" ;;
        esac
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

# ── SSH host keys ────────────────────────────────────────────────────
# The image ships NO /etc/ssh/ssh_host_* (see the Dockerfile): baking them
# in would share one host key across every sandbox AND ship the private
# halves inside the public image. Generate fresh, per-boot keys here —
# BEFORE starting the agent below — so `GET /ssh/host-keys` (apps/agent-v2/
# src/ssh.rs) can report the real key as soon as the agent is reachable; the
# server pins whatever it gets back into the sshpiper Pipe / in-server proxy
# right after boot. `-A` only (re)generates keys that are missing, so this is
# a no-op on a resumed disk... except /etc/ssh lives on the container's
# EPHEMERAL rootfs (not /data), so every restart regenerates — intentional:
# per-boot keys, nothing persisted to leak.
ssh-keygen -A >/dev/null 2>&1

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
