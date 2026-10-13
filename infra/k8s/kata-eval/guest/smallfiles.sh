#!/bin/sh
# Runs INSIDE the guest: a node_modules-like small-file workload on the home
# overlay (ext4 upper on the block PVC). Reads are guest-cache warm: the
# container cannot drop caches (/proc/sys is read-only), which matches what a
# user sees right after writing files.
t() { s=$(date +%s.%N); "$@" >/dev/null 2>&1; e=$(date +%s.%N); echo "$e - $s" | bc; }
SRC=/usr
echo "dataset: $(find $SRC -type f | wc -l) files, $(du -sm $SRC | cut -f1) MB"
echo "copy-in   $(t sh -c "cp -a $SRC /home/dev/.eval-bench && sync")s"
echo "read      $(t sh -c 'tar cf - /home/dev/.eval-bench | cat > /dev/null')s"
echo "stat walk $(t sh -c 'find /home/dev/.eval-bench -type f | wc -l')s"
echo "rm -rf    $(t sh -c 'rm -rf /home/dev/.eval-bench && sync')s"
