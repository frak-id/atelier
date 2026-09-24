#!/usr/bin/env bash
# Materialize Open-Inspect at the pinned revision with the Atelier provider
# applied. Used by the `open-inspect` image seed and to deploy the control plane.
#
#   integrations/open-inspect/checkout.sh <dir>
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=upstream.env
source "$here/upstream.env"

dest="${1:?usage: checkout.sh <dir>}"
if [[ -e "$dest" ]]; then
  echo "checkout.sh: $dest already exists" >&2
  exit 1
fi

# Leave nothing half-done behind: a failed run can simply be retried.
trap 'rm -rf "$dest"' ERR
git init -q "$dest"
git -C "$dest" fetch -q --depth 1 "$OPEN_INSPECT_REPO" "$OPEN_INSPECT_REF"
git -C "$dest" -c advice.detachedHead=false checkout -q FETCH_HEAD
git -C "$dest" apply "$here/atelier-provider.patch"
