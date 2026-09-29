#!/usr/bin/env bash
# Cutover gate for a Kata RuntimeClass: does atelier's sandbox pod shape work
# on it, and does the pod memory limit really bound the VM?
#
#   infra/k8s/v2/kata-eval/validate.sh <runtimeClass> [rollbackClass]
#
# Runs in its own namespace ($NS, default kata-eval), deleted at the end
# (KEEP=1 to keep it). Exit 0 only if every check passes. See README.md.
source "$(dirname "$0")/lib.sh"
RC=${1:?usage: validate.sh <runtimeClass> [rollbackClass]}
RB=${2:-}
PASSED=0 FAILED=0
trap '[ "${KEEP:-0}" = 1 ] || cleanup_ns' EXIT

say "== node prerequisites"
facts=$(node 'echo "dio=$(losetup -n -O DIO /dev/loop0 2>/dev/null | tr -d " ")"; echo "sev=$(cat /sys/module/kvm_amd/parameters/sev 2>/dev/null || echo n/a)"') \
  || { fail "cannot read node facts over ssh"; exit 1; }
dio=$(sed -n 's/^dio=//p' <<<"$facts"); sev=$(sed -n 's/^sev=//p' <<<"$facts")
case "$dio" in 1) pass "thin-pool loop device has direct I/O";; "") pass "no loop0 (thin pool on a real device)";; *) fail "loop0 direct I/O is off: losetup --direct-io=on /dev/loop0";; esac
case "$sev" in N|0|n/a) pass "kvm_amd sev=$sev";; *) fail "kvm_amd sev=$sev: runtime-rs CLH fails 'SEV not supported' (set options kvm_amd sev=0)";; esac

say "== RuntimeClass $RC"
if ! overhead=$(kubectl --context "$KUBE_CONTEXT" get runtimeclass "$RC" -o jsonpath='{.overhead.podFixed.memory}' 2>/dev/null); then
  fail "RuntimeClass $RC not found"; exit 1
fi
echo "  overhead memory: ${overhead:-none}   image: $EVAL_IMAGE"
ensure_ns

say "== fresh boot on a block PVC (sandbox-boot.sh)"
P=v-boot
pvc $P 10Gi
t0=$(date +%s)
pod $P "$RC" $P 1
if ready $P && agent_health $P; then pass "agent healthy after $(($(date +%s) - t0))s"; else fail "pod/agent never became ready"; K describe pod $P | tail -15; exit 1; fi
K logs $P | grep -qE "formatting (new|fresh) workspace device" && pass "fresh disk formatted by the mkfs guard" || fail "no fresh-format log line"
gexec $P sh -c 'mount | grep -q "^/dev/atelier-data on /data type ext4"' && pass "/data is ext4 on /dev/atelier-data" || fail "/data not mounted from the block device"
echo "  device: $(gexec $P sh -c 'lsblk -dno NAME,SIZE $(readlink -f /dev/atelier-data)')  guest: $(gexec $P nproc) vCPU, $(gexec $P sh -c "free -m | awk '/Mem/{print \$2}'") MiB"

say "== toolset materialize + home overlay"
out=$(materialize $P) && pass "POST /toolsets -> $out" || fail "POST /toolsets failed"
gexec $P test -e /run/home-ready && pass "/run/home-ready" || fail "/run/home-ready missing"
gexec $P sh -c 'mount | grep -q "^overlay on /home/dev type overlay"' && pass "/home/dev is an overlay" || fail "/home/dev not an overlay"
gexec $P sh -c 'su dev -c "echo ok > /home/dev/.eval-write"' && pass "dev can write its home" || fail "dev cannot write /home/dev"
gexec $P sh -c 'pgrep -x sshd >/dev/null' && pass "sshd running" || fail "sshd not running"
# Renaming a lower-layer directory needs redirect_dir + trusted.overlay.* on
# the ext4 upper: the property the block-PVC design exists for.
rename=$(K exec -i $P -- python3 - <<'EOF'
import os, re
opts = next(l.split()[3] for l in open("/proc/mounts") if l.split()[1] == "/home/dev")
lowers = re.search(r"lowerdir=([^,]+)", opts).group(1).split(":")
d = next((e for l in lowers for e in sorted(os.listdir(l)) if os.path.isdir(os.path.join(l, e)) and not os.path.islink(os.path.join(l, e))), None)
if d is None:
    print("SKIP no directory in the lower layers"); raise SystemExit
os.rename(f"/home/dev/{d}", "/home/dev/.eval-renamed")
x = os.getxattr("/data/upper/.eval-renamed", "trusted.overlay.redirect")
os.rename("/home/dev/.eval-renamed", f"/home/dev/{d}")
print("OK" if x else "NOXATTR", d)
EOF
)
case "$rename" in OK*) pass "lower dir rename (${rename#OK }) sets trusted.overlay.redirect";; SKIP*) echo "  skip: ${rename#SKIP } (set TOOLSET_REF)";; *) fail "lower dir rename: $rename";; esac

say "== memory bound: page-cache churn then an anon hog (${MEM:-2Gi} pod)"
K cp "$HERE/guest/stress.sh" "$P:/tmp/stress.sh" >/dev/null 2>&1
gexec $P sh /tmp/stress.sh 2>&1 | sed 's/^/  guest| /'
sleep 3
read -r cgmax peak oomk <<<"$(pod_memcg $P)"
echo "  host: cgroup max ${cgmax}Mi, peak ${peak}Mi, host oom_kill=$oomk, restarts=$(restarts $P)"
[ "$oomk" = 0 ] && [ "$(restarts $P)" = 0 ] && pass "VM survived; the guest OOM killer handled the hog" || fail "host OOM-killed the VM (see README: cache_direct / overhead / loop DIO)"

if [ -n "$RB" ]; then
  say "== disk portability $RC <-> $RB (resume path, no reformat)"
  # On /data itself (the disk under test): /home/dev is only assembled after
  # a materialize, so after a VM restart it would be the ephemeral rootfs.
  gexec $P sh -c 'echo portable > /data/.eval-marker; sync'
  for step in "$RB" "$RC"; do
    del $P; pod $P "$step" $P 0
    if ready $P && agent_health $P && materialize $P >/dev/null; then
      if K logs $P | grep -qE "formatting (new|fresh) workspace|REFUSING"; then fail "$step reformatted or refused the disk"
      elif [ "$(gexec $P cat /data/.eval-marker 2>/dev/null)" = portable ] && gexec $P test -e /run/home-ready; then pass "$step resumed the disk with data intact"
      else fail "$step: marker missing after resume"; fi
    else fail "$step: resume boot failed"; fi
  done
fi

say "== teardown"
vmm=$(pod_vmm_pid $P)
del $P
sleep 3
if [ -z "$vmm" ]; then fail "could not find the pod's VMM process"
elif node "kill -0 $vmm 2>/dev/null"; then fail "VMM pid $vmm still running after pod deletion"
else pass "VMM (pid $vmm) exited with the pod"; fi

say "== result: $PASSED passed, $FAILED failed"
[ "$FAILED" = 0 ]
