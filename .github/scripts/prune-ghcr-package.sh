#!/usr/bin/env bash
# Prune old untagged and nightly-* versions of one GHCR container package.
#
# Why children must be protected: every tag points at an OCI image index (or
# Docker manifest list). Its per-platform image manifests and attestation
# manifests are listed by GHCR as separate UNTAGGED package versions. Deleting
# "old untagged versions" therefore deletes the children of tags that are kept,
# and the tag then fails with `manifest unknown`. So before deleting anything
# we walk the manifest of every kept version and protect each child digest.
#
# Env:
#   PACKAGE        package name under the frak-id org (required)
#   GH_TOKEN       token with packages access (required)
#   GITHUB_ACTOR   user for the registry token request (required)
#   DRY_RUN        "true" to only print what would be deleted (default false)
#   RETENTION_DAYS age after which a version may be deleted (default 7)
#
# Fails closed: if any kept version's manifest cannot be fetched or parsed,
# nothing is deleted for the package and the script exits non-zero.

set -euo pipefail

ORG="frak-id"
REGISTRY="https://ghcr.io"
ACCEPT_MANIFESTS="application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json"

# Versions with at least one tag that does not start with `nightly-`.
# Prints one digest (version name) per line.
kept_digests() {
  jq -r '
    .[]
    | select((.metadata.container.tags // []) | any(startswith("nightly-") | not))
    | .name
  '
}

# Versions older than $cutoff that are untagged or only tagged `nightly-*`,
# and whose digest is not in the protected set ($protected: JSON array).
# Prints "id<TAB>digest" lines.
deletable_versions() {
  local cutoff=$1 protected=$2
  jq -r --arg cutoff "$cutoff" --argjson protected "$protected" '
    .[]
    | select(.updated_at < $cutoff)
    | select((.metadata.container.tags // []) | all(startswith("nightly-")))
    | select(.name as $d | $protected | index($d) | not)
    | "\(.id)\t\(.name)"
  '
}

registry_token() {
  curl -fsS -u "$GITHUB_ACTOR:$GH_TOKEN" \
    "$REGISTRY/token?scope=repository:$ORG/$PACKAGE:pull" | jq -er '.token'
}

# Prints the manifest JSON for a digest. Refreshes the token once on 401.
fetch_manifest() {
  local digest=$1 out code
  out=$(mktemp)
  for attempt in 1 2; do
    code=$(curl -sS -o "$out" -w '%{http_code}' \
      -H "Authorization: Bearer $REGISTRY_TOKEN" \
      -H "Accept: $ACCEPT_MANIFESTS" \
      "$REGISTRY/v2/$ORG/$PACKAGE/manifests/$digest") || code=000
    if [ "$code" = 401 ] && [ "$attempt" = 1 ]; then
      REGISTRY_TOKEN=$(registry_token) || return 1
      continue
    fi
    break
  done
  if [ "$code" != 200 ]; then
    echo "manifest $digest: HTTP $code" >&2
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}

# Appends the child digests of $1 to $PROTECTED_FILE. Children are protected
# from the parent's list alone; only a child that is itself an index is fetched
# and walked, up to $2 more levels. Image children are not fetched, so a kept
# tag whose children are already gone does not block pruning the package.
# Returns non-zero if a manifest that must be read is unusable.
protect_children() {
  local digest=$1 depth=$2 manifest children child media
  manifest=$(fetch_manifest "$digest") || return 1
  if ! echo "$manifest" | jq -e '(.schemaVersion | type) == "number"' >/dev/null 2>&1; then
    echo "manifest $digest: cannot parse" >&2
    return 1
  fi
  children=$(echo "$manifest" | jq -r '(.manifests // [])[] | "\(.digest)\t\(.mediaType // "")"')
  while IFS=$'\t' read -r child media; do
    [ -n "$child" ] || continue
    echo "$child" >>"$PROTECTED_FILE"
    case "$media" in
      application/vnd.oci.image.index.v1+json | application/vnd.docker.distribution.manifest.list.v2+json)
        if [ "$depth" -gt 0 ]; then
          protect_children "$child" $((depth - 1)) || return 1
        fi
        ;;
    esac
  done <<<"$children"
}

main() {
  : "${PACKAGE:?}" "${GH_TOKEN:?}" "${GITHUB_ACTOR:?}"
  local dry_run=${DRY_RUN:-false} retention=${RETENTION_DAYS:-7}
  local cutoff tmp versions_file kept_count protected_count deleted=0 failed=0
  cutoff=$(date -d "$retention days ago" -u +%Y-%m-%dT%H:%M:%SZ)
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  versions_file="$tmp/versions.json"
  PROTECTED_FILE="$tmp/protected.txt"
  : >"$PROTECTED_FILE"

  echo "Pruning $PACKAGE (dry_run=$dry_run): versions older than $cutoff, untagged or nightly-* only"

  # 1. List every version before deleting anything. A listing failure aborts
  #    the job (set -e on the redirected command), never a silent partial list.
  gh api --paginate "/orgs/$ORG/packages/container/$PACKAGE/versions?per_page=100" \
    >"$tmp/pages.json"
  jq -s 'add // []' "$tmp/pages.json" >"$versions_file"

  # 2. Kept versions.
  local kept
  kept=$(kept_digests <"$versions_file" | sort -u)
  kept_count=$(echo "$kept" | grep -c . || true)

  # 3. Protect every child of every kept version.
  REGISTRY_TOKEN=$(registry_token) || {
    echo "::error::$PACKAGE: cannot get a registry token; nothing deleted" >&2
    exit 1
  }
  local digest
  for digest in $kept; do
    if ! protect_children "$digest" 1; then
      echo "::error::$PACKAGE: cannot read the manifest of kept version $digest; nothing deleted" >&2
      failed=1
      break
    fi
  done
  if [ "$failed" -ne 0 ]; then
    exit 1
  fi
  sort -u "$PROTECTED_FILE" -o "$PROTECTED_FILE"
  protected_count=$(grep -c . "$PROTECTED_FILE" || true)
  local protected_json
  protected_json=$(jq -R . <"$PROTECTED_FILE" | jq -s .)

  echo "Kept versions: $kept_count; protected children: $protected_count"
  if [ "$dry_run" = true ]; then
    echo "Protected child digests:"
    sed 's/^/  /' "$PROTECTED_FILE"
  fi

  # 4. Delete only old, untagged/nightly-only, unprotected versions.
  local id
  while IFS=$'\t' read -r id digest; do
    [ -n "$id" ] || continue
    if [ "$dry_run" = true ]; then
      echo "  Would delete version $id ($digest)"
    else
      echo "  Deleting version $id ($digest)"
      gh api --method DELETE "/orgs/$ORG/packages/container/$PACKAGE/versions/$id" --silent
    fi
    deleted=$((deleted + 1))
  done < <(deletable_versions "$cutoff" "$protected_json" <"$versions_file")

  if [ "$dry_run" = true ]; then
    echo "Summary $PACKAGE: kept=$kept_count protected=$protected_count would_delete=$deleted"
  else
    echo "Summary $PACKAGE: kept=$kept_count protected=$protected_count deleted=$deleted"
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
