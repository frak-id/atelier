#!/usr/bin/env bash
#
# Build + deploy the Atelier v2 stack to the hetzner-atelier k3s cluster.
#
# No local Docker: images are built by the in-cluster BuildKit builder and
# pushed to the in-cluster Zot registry (zot.zot.svc:5000). The sandbox images
# are pinned by digest downstream, so re-pushing :latest forces a fresh pull.
#
# Usage:
#   infra/k8s/v2/deploy.sh                 # build everything + roll the deployment
#   infra/k8s/v2/deploy.sh server console  # build only these, then roll
#   infra/k8s/v2/deploy.sh agent dev-base  # rebuild the sandbox image chain
#   infra/k8s/v2/deploy.sh rollout         # just restart the deployment
#
# Targets: agent  dev-base  server  console  rollout   (or "all", the default)
# Note: dev-base COPYs the agent from Zot, so build agent before dev-base.
#
set -euo pipefail

# ── config ──────────────────────────────────────────────────────────────────
CTX="${KUBE_CONTEXT:-hetzner-atelier}"
NS_SYS="atelier-v2-system"
NS_BUILD="buildkit"
NS_SANDBOX="atelier-v2-sandboxes"
REGISTRY="zot.zot.svc:5000"
DEPLOY="atelier-v2"
BUILDER_POD="v2-builder"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

K() { kubectl --context "$CTX" "$@"; }
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# ── which targets? ──────────────────────────────────────────────────────────
TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(all)
want() {
  for t in "${TARGETS[@]}"; do
    [ "$t" = "all" ] && return 0
    [ "$t" = "$1" ] && return 0
  done
  return 1
}

BUILD_AGENT=false; BUILD_DEVBASE=false; BUILD_SERVER=false; BUILD_CONSOLE=false; DO_ROLLOUT=false
want agent    && BUILD_AGENT=true
want dev-base && BUILD_DEVBASE=true
want server   && BUILD_SERVER=true
want console  && BUILD_CONSOLE=true
want rollout  && DO_ROLLOUT=true
# "all" implies a rollout; any image build should also roll the deployment.
if want all || $BUILD_SERVER || $BUILD_CONSOLE; then DO_ROLLOUT=true; fi

NEED_BUILDER=false
if $BUILD_AGENT || $BUILD_DEVBASE || $BUILD_SERVER || $BUILD_CONSOLE; then NEED_BUILDER=true; fi

# ── builder pod lifecycle ───────────────────────────────────────────────────
cleanup() { K delete pod "$BUILDER_POD" -n "$NS_BUILD" --wait=false >/dev/null 2>&1 || true; }

start_builder() {
  say "Starting BuildKit builder pod"
  cat <<EOF | K apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata: { name: $BUILDER_POD, namespace: $NS_BUILD }
spec:
  restartPolicy: Never
  containers:
    - name: buildctl
      image: moby/buildkit:latest
      command: ["sleep","infinity"]
      volumeMounts: [{ name: client-certs, mountPath: /certs, readOnly: true }]
  volumes:
    - name: client-certs
      secret: { secretName: buildkit-client-tls }
EOF
  trap cleanup EXIT
  K wait --for=condition=Ready "pod/$BUILDER_POD" -n "$NS_BUILD" --timeout=120s
}

# The running server (in $NS_SYS) now builds base images ON DEMAND via the
# in-cluster BuildKit (imageBuilder.kind=buildkit, see 30-config.yaml): it
# creates a short-lived buildctl Job in the SANDBOX namespace whose pod mTLS's
# to buildkitd. Secrets are namespace-scoped, so that namespace needs its own
# copy of the client-cert secret. Replicate it from $NS_BUILD (idempotent).
sync_build_tls() {
  say "Syncing buildkit-client-tls into $NS_SANDBOX"
  K -n "$NS_SANDBOX" delete secret buildkit-client-tls \
    --ignore-not-found >/dev/null 2>&1 || true
  K -n "$NS_BUILD" get secret buildkit-client-tls -o yaml \
    | sed -E '/^[[:space:]]*(namespace|resourceVersion|uid|creationTimestamp):/d' \
    | K -n "$NS_SANDBOX" create -f - >/dev/null
}

# buildctl invocation (mTLS to the shared buildkitd). $1 = extra buildctl args.
BUILDCTL='buildctl --addr tcp://buildkitd.buildkit.svc:1234 \
  --tlscacert /certs/ca.crt --tlscert /certs/tls.crt --tlskey /certs/tls.key \
  --tlsservername buildkitd.buildkit.svc.cluster.local'
# Zot requires these two output opts or it rejects the manifest.
OUT_OPTS='push=true,registry.insecure=true,oci-mediatypes=true,image-manifest=true'

# ── build steps ─────────────────────────────────────────────────────────────
build_agent() {
  say "Build sandbox-agent-v2:latest (apps/agent-v2)"
  tar --exclude='target' -czf /tmp/agent-v2-ctx.tgz -C apps/agent-v2 .
  K exec -n "$NS_BUILD" "$BUILDER_POD" -- mkdir -p /agent
  K cp /tmp/agent-v2-ctx.tgz "$NS_BUILD/$BUILDER_POD:/tmp/agent.tgz"
  K exec -n "$NS_BUILD" "$BUILDER_POD" -- sh -c "
set -e
cd /agent && tar xzf /tmp/agent.tgz && printf 'target\n' > .dockerignore
$BUILDCTL build --frontend dockerfile.v0 --local context=/agent --local dockerfile=/agent \
  --opt platform=linux/amd64 \
  --output type=image,name=$REGISTRY/sandbox-agent-v2:latest,$OUT_OPTS 2>&1 | tail -2
"
}

build_devbase() {
  say "Build dev-base-v2:latest (apps/server/src/runtime/registry/seeds/dev-base, --no-cache to pull fresh agent)"
  tar -czf /tmp/dev-base-ctx.tgz -C apps/server/src/runtime/registry/seeds/dev-base .
  K exec -n "$NS_BUILD" "$BUILDER_POD" -- mkdir -p /devbase
  K cp /tmp/dev-base-ctx.tgz "$NS_BUILD/$BUILDER_POD:/tmp/devbase.tgz"
  K exec -n "$NS_BUILD" "$BUILDER_POD" -- sh -c "
set -e
cd /devbase && tar xzf /tmp/devbase.tgz && printf '\n' > .dockerignore
$BUILDCTL build --frontend dockerfile.v0 --local context=/devbase --local dockerfile=/devbase \
  --opt platform=linux/amd64 --no-cache \
  --output type=image,name=$REGISTRY/dev-base-v2:latest,$OUT_OPTS 2>&1 | tail -2
"
}

# Server + console share one repo context tarball.
REPO_CTX_SENT=false
send_repo_ctx() {
  $REPO_CTX_SENT && return 0
  tar --exclude='node_modules' --exclude='.git' --exclude='**/target' --exclude='dist' \
      --exclude='*.tar.gz' --exclude='.notes' -czf /tmp/v2-ctx.tgz .
  K exec -n "$NS_BUILD" "$BUILDER_POD" -- mkdir -p /ctx
  K cp /tmp/v2-ctx.tgz "$NS_BUILD/$BUILDER_POD:/tmp/v2-ctx.tgz"
  K exec -n "$NS_BUILD" "$BUILDER_POD" -- sh -c "
cd /ctx && tar xzf /tmp/v2-ctx.tgz && printf 'node_modules\n.git\n*.tar.gz\n' > .dockerignore
"
  REPO_CTX_SENT=true
}

build_target() { # $1 = server|console, $2 = image name
  say "Build $2 (Dockerfile.v2 target=$1)"
  send_repo_ctx
  K exec -n "$NS_BUILD" "$BUILDER_POD" -- sh -c "
set -e
$BUILDCTL build --frontend dockerfile.v0 --local context=/ctx --local dockerfile=/ctx \
  --opt filename=Dockerfile.v2 --opt target=$1 --opt platform=linux/amd64 \
  --output type=image,name=$REGISTRY/$2,$OUT_OPTS 2>&1 | tail -2
"
}

# ── run ─────────────────────────────────────────────────────────────────────
if $NEED_BUILDER; then start_builder; fi
$BUILD_AGENT   && build_agent
$BUILD_DEVBASE && build_devbase
$BUILD_SERVER  && build_target server  atelier-server:v2
$BUILD_CONSOLE && build_target console atelier-console:v2
if $NEED_BUILDER; then cleanup; trap - EXIT; fi

sync_build_tls

if $DO_ROLLOUT; then
  say "Rolling deploy/$DEPLOY"
  K rollout restart "deploy/$DEPLOY" -n "$NS_SYS"
  K rollout status  "deploy/$DEPLOY" -n "$NS_SYS" --timeout=180s
fi

say "Done"
K get pods -n "$NS_SYS" -o wide | tail -n +1
