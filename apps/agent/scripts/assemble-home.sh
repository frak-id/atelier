#!/usr/bin/env bash
# Assemble /home/dev as ONE overlay: the toolset mounts (and the image's
# /home/skel) as read-only lowers over the writable PVC upper, then signal
# readiness. Runs as root.
#
# args: LOWERDIR   colon-joined lowers, highest priority first
# env:  HOME_DIR OVERLAY_UPPER OVERLAY_WORK OVERLAY_OPTS READY_MARKER FAILED_MARKER
#
# `chown 1000:1000` the upper root only (NOT -R): overlayfs surfaces the
# upper's own uid/gid as the merged root, and a fresh /data/upper is root:root,
# so without it `dev` can't create top-level entries in its own home. -R would
# clobber the ownership of files copied up from the lowers.
#
# /home/dev is bare here (the entrypoint never mounts it), so `mountpoint -q`
# is false on a normal boot; the umount only makes an agent retry within the
# same pod safe. If it IS mounted and the umount fails, `set -e` aborts
# instead of stacking a second overlay on the same upper/work.
set -euo pipefail

lowerdir=$1

mkdir -p "$OVERLAY_UPPER" "$OVERLAY_WORK"
chown 1000:1000 "$OVERLAY_UPPER"
if mountpoint -q "$HOME_DIR"; then umount "$HOME_DIR"; fi
mount -t overlay overlay "$HOME_DIR" \
    -o "lowerdir=$lowerdir,upperdir=$OVERLAY_UPPER,workdir=$OVERLAY_WORK,$OVERLAY_OPTS"
: >"$READY_MARKER"
rm -f "$FAILED_MARKER"
