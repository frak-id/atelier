#!/usr/bin/env bash
# Shared helpers for the Kata runtime evaluation scripts (see README.md).
# Sourced, not executed.
set -uo pipefail

KUBE_CONTEXT=${KUBE_CONTEXT:-hetzner-atelier}
NS=${NS:-kata-eval}
NODE_SSH=${NODE_SSH:-hetzner}           # ssh target of the (single) k3s node
AGENT_PORT=${AGENT_PORT:-9998}
TOOLSET_REF=${TOOLSET_REF:-}            # optional real toolset to materialize
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

K() { kubectl --context "$KUBE_CONTEXT" -n "$NS" "$@"; }
# One multiplexed connection: hetzner-atelier rate-limits ssh (ufw `limit 22`
# refuses a 7th connection within 30s, and fail2ban is active).
node() {
  ssh -o BatchMode=yes -o ControlMaster=auto -o ControlPersist=120 \
    -o ControlPath=/tmp/kev-%C "$NODE_SSH" "$@"  # short: macOS caps socket paths at 104 bytes
}
say() { printf '\033[1m%s\033[0m\n' "$*"; }
pass() { printf '  \033[32mPASS\033[0m %s\n' "$*"; PASSED=$((${PASSED:-0} + 1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$*"; FAILED=$((${FAILED:-0} + 1)); }

# Resolve dev-base:latest to a digest so the run tests the current image, not
# whatever the node has cached under the tag. Override with IMAGE=...
resolve_image() {
  if [ -n "${IMAGE:-}" ]; then echo "$IMAGE"; return; fi
  local ip digest
  ip=$(kubectl --context "$KUBE_CONTEXT" -n zot get svc zot -o jsonpath='{.spec.clusterIP}')
  digest=$(node "curl -sfI -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' http://$ip:5000/v2/dev-base/manifests/latest" \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}')
  [ -n "$digest" ] || { echo "cannot resolve dev-base:latest digest" >&2; exit 1; }
  echo "zot.zot.svc:5000/dev-base@$digest"
}

ensure_ns() {
  # A previous run's namespace may still be terminating (PVC teardown).
  while [ "$(kubectl --context "$KUBE_CONTEXT" get ns "$NS" -o jsonpath='{.status.phase}' 2>/dev/null)" = Terminating ]; do sleep 3; done
  kubectl --context "$KUBE_CONTEXT" get ns "$NS" >/dev/null 2>&1 \
    || kubectl --context "$KUBE_CONTEXT" create ns "$NS" >/dev/null
  if ! K get secret eval-ssh-key >/dev/null 2>&1; then
    local tmp; tmp=$(mktemp -d)
    ssh-keygen -q -t ed25519 -N '' -f "$tmp/key" >/dev/null
    K create secret generic eval-ssh-key --from-file=ssh-publickey="$tmp/key.pub" >/dev/null
    rm -rf "$tmp"
  fi
}

cleanup_ns() { kubectl --context "$KUBE_CONTEXT" delete ns "$NS" --wait=true --timeout=300s >/dev/null 2>&1 || true; }

# pvc <name> [size]
pvc() {
  K apply -f - >/dev/null <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: $1, labels: {app: kata-eval}}
spec:
  accessModes: [ReadWriteOnce]
  volumeMode: Block
  storageClassName: topolvm-thin
  resources: {requests: {storage: ${2:-10Gi}}}
EOF
}

# pod <name> <runtimeClass> <pvc|-> <fresh 0|1> [cmd...]
# Mirrors apps/server/src/runtime/kube/kube.resources.ts buildSandboxPod:
# sandbox-boot.sh entrypoint, uid 0 + SYS_ADMIN, raw block PVC at
# /dev/atelier-data, the ssh key Secret mount, requests.memory == limit.
# CPU / MEM env override the size (defaults: 2 vCPU, 2Gi = the server's
# smallest common size).
pod() {
  local name=$1 rc=$2 claim=$3 fresh=$4; shift 4
  local cmd='["/etc/sandbox/sandbox-boot.sh"]'
  if [ $# -gt 0 ]; then cmd=$(printf '"%s",' "$@"); cmd="[${cmd%,}]"; fi
  local mem=${MEM:-2Gi} cpu=${CPU:-2}
  {
    cat <<EOF
apiVersion: v1
kind: Pod
metadata: {name: $name, labels: {app: kata-eval}}
spec:
  runtimeClassName: $rc
  hostname: ${name:0:8}
  terminationGracePeriodSeconds: 5
  containers:
  - name: sandbox
    image: $EVAL_IMAGE
    imagePullPolicy: IfNotPresent
    command: $cmd
    securityContext: {runAsUser: 0, capabilities: {add: [SYS_ADMIN]}}
    ports: [{name: agent, containerPort: $AGENT_PORT}, {name: ssh, containerPort: 22}]
    env:
    - {name: SANDBOX_ID, value: $name}
    - {name: AGENT_PASSWORD, value: eval}
EOF
    [ "$fresh" = 1 ] && echo '    - {name: ATELIER_DATA_FRESH, value: "1"}'
    cat <<EOF
    resources:
      requests: {cpu: 500m, memory: $mem}
      limits: {cpu: "$cpu", memory: $mem}
    volumeMounts: [{name: ssh-pipe-key, mountPath: /etc/sandbox/ssh, readOnly: true}]
EOF
    [ "$claim" != - ] && echo '    volumeDevices: [{name: workspace, devicePath: /dev/atelier-data}]'
    cat <<EOF
  volumes:
  - name: ssh-pipe-key
    secret: {secretName: eval-ssh-key, items: [{key: ssh-publickey, path: authorized_keys}], defaultMode: 0644}
EOF
    [ "$claim" != - ] && printf '  - name: workspace\n    persistentVolumeClaim: {claimName: %s}\n' "$claim"
  } | K apply -f - >/dev/null
}

ready() { K wait --for=condition=Ready "pod/$1" --timeout="${2:-180s}" >/dev/null; }
pod_ip() { K get pod "$1" -o jsonpath='{.status.podIP}'; }
restarts() { K get pod "$1" -o jsonpath='{.status.containerStatuses[0].restartCount}'; }
gexec() { local p=$1; shift; K exec "$p" -- "$@"; }
del() { K delete pod "$@" --wait=true >/dev/null 2>&1; }

# Agent calls go from the node (the pod network is not reachable from here).
agent_health() { node "until curl -sf -m1 http://$(pod_ip "$1"):$AGENT_PORT/health >/dev/null; do sleep 0.2; done"; }
materialize() {
  local refs='[]'; [ -n "$TOOLSET_REF" ] && refs="[\"$TOOLSET_REF\"]"
  node "curl -sf -X POST -H 'Content-Type: application/json' -d '{\"toolsets\":$refs}' http://$(pod_ip "$1"):$AGENT_PORT/toolsets"
}

# Host-side memory cgroup facts for a pod: "max peak oom_kill" in MiB.
pod_memcg() {
  local uid; uid=$(K get pod "$1" -o jsonpath='{.metadata.uid}' | tr - _)
  node "d=\$(ls -d /sys/fs/cgroup/kubepods.slice/kubepods-*.slice/kubepods-*-pod$uid.slice /sys/fs/cgroup/kubepods.slice/kubepods-pod$uid.slice 2>/dev/null | head -1); echo \$((\$(cat \$d/memory.max)/1048576)) \$((\$(cat \$d/memory.peak)/1048576)) \$(awk '/oom_kill /{print \$2}' \$d/memory.events)"
}

# PID of the pod's VMM (cloud-hypervisor / qemu) on the node, from its cgroup.
pod_vmm_pid() {
  local uid; uid=$(K get pod "$1" -o jsonpath='{.metadata.uid}' | tr - _)
  node "for f in /sys/fs/cgroup/kubepods.slice/kubepods*-pod$uid.slice/cgroup.procs /sys/fs/cgroup/kubepods.slice/*/kubepods*-pod$uid.slice/cgroup.procs /sys/fs/cgroup/kubepods.slice/*/kubepods*-pod$uid.slice/*/cgroup.procs; do [ -f \$f ] && cat \$f; done 2>/dev/null | while read -r p; do c=\$(cat /proc/\$p/comm 2>/dev/null); case \$c in cloud-hyperviso|qemu-system-x86) echo \$p;; esac; done | head -1"
}

node true || { echo "cannot ssh to the node ($NODE_SSH)" >&2; exit 1; }
EVAL_IMAGE=${EVAL_IMAGE:-$(resolve_image)}
[ -n "$EVAL_IMAGE" ] || exit 1
