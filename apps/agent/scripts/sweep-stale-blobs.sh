#!/usr/bin/env bash
# Delete every blob in TOOLSETS_DIR whose digest is not listed. Run only
# after a successful assembly (a failed boot must never delete a blob it may
# still need on retry). With no digests it deletes every blob.
#
# args: [KEEP_DIGEST...]
# env:  TOOLSETS_DIR  blob store on the PVC
#
# Matches by digest whatever the extension, so a blob is kept in any format.
# Non-blob files (.materialize.json) never match the blob globs.
set -euo pipefail
shopt -s nullglob

for blob in "$TOOLSETS_DIR"/*.erofs "$TOOLSETS_DIR"/*.sqfs "$TOOLSETS_DIR"/*.tzst; do
    base=${blob##*/}
    digest=${base%.*}
    keep=0
    for wanted in "$@"; do
        if [ "$digest" = "$wanted" ]; then keep=1; fi
    done
    if [ "$keep" -eq 0 ]; then rm -f "$blob"; fi
done
