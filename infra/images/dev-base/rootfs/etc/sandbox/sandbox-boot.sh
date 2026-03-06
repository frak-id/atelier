#!/bin/sh
# Sandbox boot script — K8s entrypoint for Kata Container pods.
#
# When a fresh PVC is mounted at /home/dev (no prebuild), the image's
# original contents are hidden.  This script restores dotfiles, .bun,
# etc. from /home/skel (populated at image build time), then hands off
# to the sandbox-agent.

if [ -d /home/skel ] && [ ! -d /home/dev/.bun ]; then
    cp -a /home/skel/. /home/dev/
    chown -R 1000:1000 /home/dev
fi

exec /usr/local/bin/sandbox-agent "$@"
