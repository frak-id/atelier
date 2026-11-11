#!/usr/bin/env bash
# Stage the selected home path-sets, pack them into one blob and `oras push`
# it. Shared by toolset build and capture; runs as `dev`. Prints oras' output
# (the agent parses the manifest digest from it).
#
# args: TARGET EXCLUDE_COUNT [EXCLUDE_GLOB...] PATH...
#   TARGET   full registry reference incl. host and tag
#   EXCLUDE_GLOB basename globs skipped at every depth, any entry type
#   PATH     home-relative paths to include
# env:  HOME_DIR        the home the paths are relative to
#       STAGE_DIR       scratch dir for the staged tree and the blob
#       FILE_EXCLUDES   newline-separated basename globs skipped at every
#                       depth as files and symlinks only, never directories
#                       (the secret-file floor: `credentials` drops
#                       ~/.aws/credentials, not an SDK's `credentials/` module)
#       KEY_FILES       newline-separated basename globs of key files, dropped
#                       only when they hold a private key or are not text
#       PRIVATE_KEY_PATTERN extended regex of a PEM private-key header
#       BLOB_FORMAT     erofs | squashfs | tar
#       BLOB_EXT        file extension recorded in the blob name
#       BLOB_MEDIA_TYPE OCI layer media type
#       ARTIFACT_TYPE   OCI artifact type
#
# Each path is staged individually (the parent dir is recreated under the
# stage first) so nested paths like `.config/pi` keep their depth. rsync -H
# keeps hardlinks (a pnpm-style store would otherwise be duplicated per link).
#
# Cleanup is best-effort: the stage lives on the virtio-fs home, where native
# `.node` files can return ESTALE on unlink. The blob is already pushed by
# then, and the next build/capture sweeps leftovers (sweep-stage-scratch.sh).
set -euo pipefail

target=$1
exclude_count=$2
shift 2
excludes=("${@:1:exclude_count}")
paths=("${@:exclude_count+1}")

mkdir -p "$STAGE_DIR"
cd "$STAGE_DIR"
stage=$(mktemp -d atelier-toolset-stage.XXXXXX)
name=$(mktemp -u "atelier-toolset.XXXXXX.$BLOB_EXT")
trap 'rm -rf "$stage" 2>/dev/null ||:; rm -f "$name" 2>/dev/null ||:' EXIT

rsync_args=(-aH)
for glob in ${excludes[@]+"${excludes[@]}"}; do
    rsync_args+=("--exclude=$glob")
done
# rsync applies the first matching rule, and a trailing `/` matches
# directories only: a directory with a secret-file name hits the include and
# is kept (its content still goes through every rule), anything else with that
# name hits the exclude. Unset FILE_EXCLUDES fails under `set -u`: a missing
# floor must not pass silently.
while IFS= read -r glob; do
    [ -n "$glob" ] && rsync_args+=("--include=$glob/" "--exclude=$glob")
done <<<"$FILE_EXCLUDES"
for p in ${paths[@]+"${paths[@]}"}; do
    parent="$stage/$(dirname "$p")"
    mkdir -p "$parent"
    rsync ${rsync_args[@]+"${rsync_args[@]}"} "$HOME_DIR/$p" "$parent/"
done

# Key files go after staging, by content: a CA bundle such as certifi's
# `cacert.pem` ships, a TLS or SSH private key does not. Not text (a DER key)
# counts as a key. A staged directory can be read-only (Go's module cache is
# 0555): it is opened for the unlink and closed again, so its mode ships as is.
drop_staged() {
    local dir
    dir=$(dirname "$1")
    if [ -w "$dir" ]; then
        rm -f -- "$1"
    else
        chmod u+w "$dir" && rm -f -- "$1" && chmod u-w "$dir"
    fi
}
key_names=()
while IFS= read -r glob; do
    [ -n "$glob" ] || continue
    [ ${#key_names[@]} -eq 0 ] || key_names+=(-o)
    key_names+=(-name "$glob")
done <<<"$KEY_FILES"
if [ ${#key_names[@]} -gt 0 ]; then
    find "$stage" -type f \( "${key_names[@]}" \) -print0 |
        while IFS= read -r -d '' f; do
            if ! grep -qI '' "$f" || grep -qE -e "$PRIVATE_KEY_PATTERN" "$f"; then
                drop_staged "$f"
            fi
        done
fi

# Note the argument order differs: mkfs.erofs <img> <dir>, mksquashfs <dir> <img>.
case "$BLOB_FORMAT" in
erofs)
    # -zlz4hc: every EROFS kernel decompresses LZ4 (lz4hc included), while
    # zstd is an optional kernel config the guest may not have. -T0 pins timestamps (the stage is
    # rsynced as `dev`, so ownership is already uid/gid 1000).
    mkfs.erofs -zlz4hc -T0 "$name" "$stage"
    ;;
squashfs)
    mksquashfs "$stage" "$name" -comp zstd -noappend -no-exports \
        -all-time 0 -mkfs-time 0 -force-uid 1000 -force-gid 1000
    ;;
tar)
    tar --zstd --numeric-owner --owner=1000 --group=1000 --mtime=@0 \
        --sort=name -cf "$name" -C "$stage" .
    ;;
*)
    echo "unknown blob format: $BLOB_FORMAT" >&2
    exit 1
    ;;
esac

oras push --plain-http "$target" \
    --artifact-type "$ARTIFACT_TYPE" "$name:$BLOB_MEDIA_TYPE"
