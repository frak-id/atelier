#!/usr/bin/env bash
# Loop-mount DIGEST's blob read-only at MOUNT_POINT (or extract it, for a
# `.tzst` tarball blob). Runs as root. `mountpoint -q` guards make a retry
# within the same pod a no-op instead of a double-mount error.
#
# args: DIGEST MOUNT_POINT
# env:  TOOLSETS_DIR  blob store on the PVC
set -euo pipefail
shopt -s nullglob

digest=$1
mount_point=$2

mkdir -p "$mount_point"
existing=("$TOOLSETS_DIR/$digest".*)
if [ "${#existing[@]}" -lt 1 ]; then
    echo "blob for digest $digest missing after pull" >&2
    exit 1
fi
blob=${existing[0]}
case "$blob" in
*.erofs) mountpoint -q "$mount_point" || mount -t erofs -o ro,loop "$blob" "$mount_point" ;;
*.sqfs) mountpoint -q "$mount_point" || mount -t squashfs -o ro,loop "$blob" "$mount_point" ;;
*.tzst) [ -n "$(ls -A "$mount_point" 2>/dev/null)" ] || tar --zstd -xf "$blob" -C "$mount_point" ;;
*)
    echo "unknown blob format: $blob" >&2
    exit 1
    ;;
esac
