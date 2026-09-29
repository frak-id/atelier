#!/bin/sh
# Runs INSIDE the sandbox guest (validate.sh copies it in).
# Phase 1: page-cache churn through the block PVC (3 x 1.5 GiB write + read
#          back). This is what used to get the whole VM OOM-killed by the host.
# Phase 2: anonymous memory hog up to 8 GiB. Expected: the GUEST OOM killer
#          kills the hog (exit 137) and the VM keeps running.
set -u
echo "guest RAM: $(free -m | awk '/Mem/{print $2}') MiB"
for i in 1 2 3; do
  dd if=/dev/zero of=/data/.eval-churn$i bs=1M count=1536 status=none conv=fsync
  cat /data/.eval-churn$i > /dev/null
  echo "churn $i/3 done, guest page cache $(free -m | awk '/Mem/{print $6}') MiB"
done
rm -f /data/.eval-churn*; sync
python3 - <<'EOF'
blocks = []
for i in range(8192):
    blocks.append(bytearray(1024 * 1024))  # touch 1 MiB each
    if i % 1024 == 0:
        print("hog", i, "MiB", flush=True)
EOF
echo "hog exit=$? (137 = guest OOM killer took the hog, VM alive)"
