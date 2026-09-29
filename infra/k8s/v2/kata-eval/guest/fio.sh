#!/bin/sh
# Runs INSIDE the guest: raw workspace-disk I/O with O_DIRECT (bypasses the
# guest page cache). $1 = target dir (default /data). Needs fio (bench.sh
# installs it).
D=${1:-/data}
run() { # name rw bs iodepth size
  fio --name="$1" --directory="$D" --rw="$2" --bs="$3" --iodepth="$4" --size="$5" \
    --ioengine=libaio --direct=1 --numjobs=1 --time_based --runtime=15 --ramp_time=2 \
    --group_reporting --output-format=json 2>/dev/null | python3 -c "
import json, sys
j = json.load(sys.stdin)['jobs'][0]
for k in ('read', 'write'):
    x = j[k]
    if x['iops']:
        p99 = x['clat_ns']['percentile'].get('99.000000', 0) / 1000
        print('%-18s %-5s %9.0f IOPS %8.1f MB/s  p99 %7.0f us' % ('$1', k, x['iops'], x['bw'] / 1024, p99))"
  rm -f "$D/$1".*
}
run randread-4k-qd32 randread 4k 32 1G
run randwrite-4k-qd32 randwrite 4k 32 1G
run randrw-4k-qd1 randrw 4k 1 1G
run seqread-1m read 1m 8 2G
run seqwrite-1m write 1m 8 2G
