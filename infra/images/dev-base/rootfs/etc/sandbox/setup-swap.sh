#!/bin/bash
# Setup swap space — called from sandbox-init.sh (boot) and manager (post-expansion)
# Safe to call multiple times: skips if swap is already active.

export PATH=/sbin:/usr/sbin:$PATH

SWAPFILE="/swapfile"
LOG="/var/log/sandbox/init.log"

log() { echo "[swap] $(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG" 2>/dev/null; }

# Already active — nothing to do
if swapon --show 2>/dev/null | grep -q "$SWAPFILE"; then
  echo swap_already_active
  exit 0
fi

# Swapfile exists but not active (e.g. prebuild restore) — just activate
if [ -f "$SWAPFILE" ]; then
  if swapon "$SWAPFILE" 2>/dev/null; then
    echo 10 > /proc/sys/vm/swappiness
    log "Swap reactivated from existing swapfile"
    echo swap_reactivated
    exit 0
  fi
  # Corrupted swapfile — remove and recreate
  rm -f "$SWAPFILE"
fi

# Calculate swap size: 100% of RAM, capped at 16GB, reserve 1GB disk
TOTAL_MEM_KB=$(awk '/MemTotal/ {print $2}' /proc/meminfo)
AVAIL_KB=$(df / | awk 'NR==2 {print $4}')
SWAP_KB=$TOTAL_MEM_KB

if [ "$SWAP_KB" -gt 16777216 ]; then
  SWAP_KB=16777216
fi

MAX_KB=$((AVAIL_KB - 1048576))
if [ "$SWAP_KB" -gt "$MAX_KB" ]; then
  SWAP_KB=$MAX_KB
fi

# Need at least 256MB to be worthwhile
if [ "$SWAP_KB" -lt 262144 ]; then
  log "Insufficient disk space for swap (available: ${AVAIL_KB}KB, would need: ${TOTAL_MEM_KB}KB + 1GB reserve)"
  echo swap_skipped_no_space
  exit 0
fi

SWAP_MB=$((SWAP_KB / 1024))
log "Creating ${SWAP_MB}MB swap file..."

if ! fallocate -l "${SWAP_MB}M" "$SWAPFILE" 2>/dev/null; then
  if ! dd if=/dev/zero of="$SWAPFILE" bs=1M count="$SWAP_MB" status=none 2>/dev/null; then
    log "Failed to allocate swapfile"
    rm -f "$SWAPFILE"
    echo swap_failed_allocate
    exit 1
  fi
fi

chmod 600 "$SWAPFILE"
mkswap "$SWAPFILE" >> "$LOG" 2>&1
swapon "$SWAPFILE" >> "$LOG" 2>&1
echo 10 > /proc/sys/vm/swappiness

log "Swap enabled: ${SWAP_MB}MB, swappiness=10"
echo "swap_created_${SWAP_MB}mb"
