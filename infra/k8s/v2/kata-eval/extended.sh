#!/usr/bin/env bash
# Runtime-dependent paths validate.sh does not cover, at pod level:
#   - toolset build + capture from inside the guest (mkfs.erofs + oras push)
#   - materialize the freshly built artifact in a NEW VM
#   - pause/resume shape: guest sync, VolumeSnapshot of the live PVC, clone,
#     boot the clone (no reformat, data + toolset blob intact)
#   - ssh into the guest as `dev` (what sshpiper / the in-server proxy do)
#
#   infra/k8s/v2/kata-eval/extended.sh <runtimeClass>
#
# Pushes two tiny artifacts to Zot under toolsets/kata-eval/probe (deleted
# at the end when the registry allows it).
source "$(dirname "$0")/lib.sh"
RC=${1:?usage: extended.sh <runtimeClass>}
SNAP_CLASS=${SNAP_CLASS:-atelier-snapshots}
PASSED=0 FAILED=0
TMPK=$(mktemp -d)
trap '[ "${KEEP:-0}" = 1 ] || cleanup_ns; rm -rf "$TMPK"; node "rm -f /tmp/kev-key" 2>/dev/null' EXIT

# Our own ssh key in the pod Secret (ensure_ns keeps an existing one).
ssh-keygen -q -t ed25519 -N '' -f "$TMPK/key" >/dev/null
while [ "$(kubectl --context "$KUBE_CONTEXT" get ns "$NS" -o jsonpath='{.status.phase}' 2>/dev/null)" = Terminating ]; do sleep 3; done
kubectl --context "$KUBE_CONTEXT" create ns "$NS" >/dev/null 2>&1
K delete secret eval-ssh-key >/dev/null 2>&1
K create secret generic eval-ssh-key --from-file=ssh-publickey="$TMPK/key.pub" >/dev/null
ensure_ns

agent_post() { # <pod> <path> <json>
  node "curl -s -w '\n%{http_code}' -X POST -H 'Content-Type: application/json' -d '$3' http://$(pod_ip "$1"):$AGENT_PORT$2"
}
tag=$(date +%s)
REPO=zot.zot.svc:5000/toolsets/kata-eval/probe

say "== boot source VM ($RC)"
A=x-src
pvc $A 10Gi
pod $A "$RC" $A 1
ready $A && agent_health $A && materialize $A >/dev/null && pass "source VM up, home materialized" || { fail "source VM"; exit 1; }

say "== toolset build + capture from the guest"
gexec $A su dev -c 'mkdir -p ~/.eval-tool/bin && printf "#!/bin/sh\necho eval-tool-ok\n" > ~/.eval-tool/bin/eval-tool && chmod +x ~/.eval-tool/bin/eval-tool && head -c 1M /dev/urandom > ~/.eval-tool/blob'
out=$(agent_post $A /toolsets/build "{\"target\":\"$REPO:build-$tag\",\"paths\":[\".eval-tool\"]}")
code=${out##*$'\n'}; body=${out%$'\n'*}
built=$(sed -n 's/.*"digest":"\(sha256:[0-9a-f]*\)".*/\1/p' <<<"$body")
[ "$code" = 200 ] && [ -n "$built" ] && pass "build pushed $built" || fail "build: HTTP $code $body"
out=$(agent_post $A /toolsets/capture "{\"target\":\"$REPO:capture-$tag\",\"paths\":[\".eval-tool\"],\"exclude\":[],\"overrides\":[]}")
code=${out##*$'\n'}; body=${out%$'\n'*}
captured=$(sed -n 's/.*"digest":"\(sha256:[0-9a-f]*\)".*/\1/p' <<<"$body")
[ "$code" = 200 ] && [ -n "$captured" ] && pass "capture pushed $captured" || fail "capture: HTTP $code $body"

say "== materialize the built artifact in a new VM"
B=x-consumer
pvc $B 5Gi
pod $B "$RC" $B 1
if ready $B && agent_health $B && [ -n "$built" ]; then
  TOOLSET_REF="$REPO@$built" materialize $B >/dev/null \
    && [ "$(gexec $B su dev -c '~/.eval-tool/bin/eval-tool')" = eval-tool-ok ] \
    && pass "built toolset mounts and runs in a fresh VM" || fail "built toolset not usable in a fresh VM"
else fail "consumer VM or build digest missing"; fi
del $B

say "== pause/resume shape: sync, snapshot the live PVC, boot the clone"
gexec $A sh -c 'echo snapshot-marker > /data/.eval-snap; sync'
K apply -f - >/dev/null <<EOF
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata: {name: x-snap}
spec: {volumeSnapshotClassName: $SNAP_CLASS, source: {persistentVolumeClaimName: $A}}
EOF
for _ in $(seq 1 60); do [ "$(K get volumesnapshot x-snap -o jsonpath='{.status.readyToUse}' 2>/dev/null)" = true ] && break; sleep 2; done
[ "$(K get volumesnapshot x-snap -o jsonpath='{.status.readyToUse}')" = true ] && pass "VolumeSnapshot ready" || fail "VolumeSnapshot not ready"
del $A
K apply -f - >/dev/null <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: x-clone, labels: {app: kata-eval}}
spec:
  accessModes: [ReadWriteOnce]
  volumeMode: Block
  storageClassName: topolvm-thin
  resources: {requests: {storage: 10Gi}}
  dataSource: {name: x-snap, kind: VolumeSnapshot, apiGroup: snapshot.storage.k8s.io}
EOF
C=x-clone
pod $C "$RC" $C 0
if ready $C && agent_health $C && materialize $C >/dev/null; then
  K logs $C | grep -qE "formatting (new|fresh) workspace|REFUSING" && fail "clone was reformatted or refused"
  [ "$(gexec $C cat /data/.eval-snap 2>/dev/null)" = snapshot-marker ] && pass "clone boots with the snapshot's data" || fail "snapshot marker missing in clone"
  gexec $C test -e /run/home-ready && pass "clone home assembled" || fail "clone home not assembled"
else fail "clone VM did not boot"; fi

say "== ssh into the guest as dev"
node "cat > /tmp/kev-key && chmod 600 /tmp/kev-key" < "$TMPK/key"
out=$(node "ssh -i /tmp/kev-key -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 dev@$(pod_ip $C) 'id -un; cat /data/.eval-snap'" 2>/dev/null)
[ "$(head -1 <<<"$out")" = dev ] && pass "ssh dev@guest works" || fail "ssh failed: $out"
del $C

say "== cleanup registry probes"
zip=$(kubectl --context "$KUBE_CONTEXT" -n zot get svc zot -o jsonpath='{.spec.clusterIP}')
for d in $built $captured; do
  node "curl -s -o /dev/null -w '%{http_code}' -X DELETE http://$zip:5000/v2/toolsets/kata-eval/probe/manifests/$d" | grep -qE '^20[02]$' \
    && echo "  deleted $d" || echo "  could not delete $d (left for registry GC)"
done

say "== result: $PASSED passed, $FAILED failed"
[ "$FAILED" = 0 ]
