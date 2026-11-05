#!/usr/bin/env bash
# Ensure a toolset blob for DIGEST exists at $TOOLSETS_DIR/<digest>.<ext>,
# pulling it with oras only when it is not already there (resume: the blob
# rode the pause snapshot). Runs as root. Mounting is mount-blob.sh's job.
#
# args: DIGEST REFERENCE
#   DIGEST     bare 64-hex digest (validated by the agent)
#   REFERENCE  full digest-pinned pull reference
# env:  TOOLSETS_DIR  blob store on the PVC
#
# The blob's format is whatever the builder's kernel supported, so the name
# carries it (.erofs / .sqfs / .tzst) and an existing blob is found by
# globbing `<digest>.*` (nullglob: an empty array when absent). `oras pull`
# writes the layer under its pushed (random) name, so the single layer is moved
# to the digest-named path keeping its extension.
#
# The scratch dir lives under TOOLSETS_DIR (same filesystem as the blob), so
# the final `mv` is an atomic rename: a kill mid-way can never leave a
# truncated file at the final path for the next boot to trust.
set -euo pipefail
shopt -s nullglob

digest=$1
reference=$2

mkdir -p "$TOOLSETS_DIR"
existing=("$TOOLSETS_DIR/$digest".*)
if [ "${#existing[@]}" -ge 1 ]; then exit 0; fi

scratch=$(mktemp -d -p "$TOOLSETS_DIR" atelier-toolset-pull.XXXXXX)
trap 'rm -rf "$scratch"' EXIT
oras pull --plain-http "$reference" -o "$scratch"
layers=("$scratch"/*.erofs "$scratch"/*.sqfs "$scratch"/*.tzst)
if [ "${#layers[@]}" -ne 1 ]; then
    echo "expected exactly one .erofs/.sqfs/.tzst layer for $reference, found ${#layers[@]}" >&2
    exit 1
fi
mv "${layers[0]}" "$TOOLSETS_DIR/$digest.${layers[0]##*.}"
