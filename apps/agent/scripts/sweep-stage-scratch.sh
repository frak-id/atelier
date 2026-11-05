#!/usr/bin/env bash
# Remove staging debris left by an earlier build/capture whose EXIT-trap
# cleanup failed (ESTALE on virtio-fs) or whose agent was killed mid-call.
# Runs at the START of every build/capture, as `dev`.
#
# env: STAGE_DIR  scratch dir under the home (dot-prefixed, created if absent)
set -euo pipefail

mkdir -p "$STAGE_DIR"
rm -rf "$STAGE_DIR"/atelier-toolset-stage.* "$STAGE_DIR"/atelier-toolset.*
