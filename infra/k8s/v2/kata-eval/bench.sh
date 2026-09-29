#!/usr/bin/env bash
# Compare Kata RuntimeClasses: cold boot to agent-healthy, raw disk I/O (fio,
# O_DIRECT) and a small-file workload on the home overlay.
#
#   infra/k8s/v2/kata-eval/bench.sh <runtimeClass> [runtimeClass...]
#
# Classes run one at a time (the node is shared). BOOT_RUNS (default 3) cold
# boots per class, each on a fresh PVC. Pods use MEM (default 4Gi).
source "$(dirname "$0")/lib.sh"
[ $# -gt 0 ] || { echo "usage: bench.sh <runtimeClass> [runtimeClass...]"; exit 2; }
export MEM=${MEM:-4Gi}
trap '[ "${KEEP:-0}" = 1 ] || cleanup_ns' EXIT
ensure_ns

for RC in "$@"; do
  say "== $RC"
  for i in $(seq 1 "${BOOT_RUNS:-3}"); do
    P=b-boot-$i
    pvc $P 10Gi
    t0=$(date +%s.%N)
    pod $P "$RC" $P 1
    until [ -n "$(pod_ip $P)" ]; do sleep 0.2; done
    agent_health $P
    t1=$(date +%s.%N)
    materialize $P >/dev/null
    t2=$(date +%s.%N)
    printf '  boot %d: agent healthy %.2fs, home materialized %.2fs\n' "$i" "$(bc <<<"$t1-$t0")" "$(bc <<<"$t2-$t0")"
    del $P; K delete pvc $P --wait=false >/dev/null
  done

  P=b-io
  pvc $P 10Gi
  pod $P "$RC" $P 1
  ready $P && agent_health $P && materialize $P >/dev/null
  gexec $P sh -c 'command -v fio >/dev/null && command -v bc >/dev/null || { apt-get -qq update && DEBIAN_FRONTEND=noninteractive apt-get -qq install -y fio bc; } >/dev/null 2>&1'
  K cp "$HERE/guest/fio.sh" "$P:/tmp/fio.sh" >/dev/null 2>&1
  K cp "$HERE/guest/smallfiles.sh" "$P:/tmp/smallfiles.sh" >/dev/null 2>&1
  gexec $P sh /tmp/fio.sh /data | sed 's/^/  /'
  gexec $P sh /tmp/smallfiles.sh | sed 's/^/  /'
  echo "  host memory: $(pod_memcg $P | awk '{printf "cgroup max %sMi, peak %sMi, oom_kill %s", $1, $2, $3}')"
  del $P; K delete pvc $P --wait=false >/dev/null
done
