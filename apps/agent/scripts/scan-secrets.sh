#!/usr/bin/env bash
# List files under the selected paths that match a secret pattern, one per
# line (relative to HOME_DIR). Read-only; runs as `dev`. No match is a clean
# pass (empty output), not an error.
#
# args: EXCLUDE_COUNT [EXCLUDE_GLOB...] PATH...
# env:  HOME_DIR           the home the paths are relative to
#       SECRET_PATTERN     extended regex
#       SCAN_EXCLUDE_DIRS  newline-separated directory names the scan skips
#
# `-I` skips binary files: secrets inside a binary (say a sqlite keystore)
# are not scanned. Accepted: captures default to private and publishing is an
# explicit separate step, so the scan gates the common plaintext-dotfile case.
set -euo pipefail

exclude_count=$1
shift
excludes=("${@:1:exclude_count}")
paths=("${@:exclude_count+1}")

grep_args=()
for glob in "${excludes[@]}"; do
    grep_args+=("--exclude=$glob")
done
while IFS= read -r dir; do
    [ -n "$dir" ] && grep_args+=("--exclude-dir=$dir")
done <<<"$SCAN_EXCLUDE_DIRS"

cd "$HOME_DIR"
# grep exits 1 on "no match": fine. Anything above 1 is a real failure.
grep -rIlE "$SECRET_PATTERN" "${grep_args[@]}" -- "${paths[@]}" 2>/dev/null ||
    {
        rc=$?
        [ "$rc" -le 1 ] || exit "$rc"
    }
