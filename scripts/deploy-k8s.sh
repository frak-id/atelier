#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# deploy-k8s.sh — Build, push, and deploy Atelier to a remote k3s server
#
# Builds the manager+dashboard Docker image for linux/amd64, pushes to GHCR,
# imports it directly into k3s containerd (no pull auth needed), copies the
# Helm chart, and runs helm upgrade --install.
#
# Prerequisites:
#   Local:  docker (with buildx), ssh, rsync
#   Server: k3s, helm, kubectl
#
# Usage:
#   DEPLOY_HOST=1.2.3.4 ./scripts/deploy-k8s.sh
#
#   # With a custom values file:
#   DEPLOY_HOST=1.2.3.4 VALUES_FILE=my-values.yaml ./scripts/deploy-k8s.sh
#
#   # With extra Helm --set flags:
#   DEPLOY_HOST=1.2.3.4 \
#     HELM_SET="--set auth.github.clientId=xxx --set auth.github.clientSecret=yyy" \
#     ./scripts/deploy-k8s.sh
#
#   # Skip image build (chart-only update):
#   DEPLOY_HOST=1.2.3.4 SKIP_BUILD=1 ./scripts/deploy-k8s.sh
# ─────────────────────────────────────────────────────────────────────────────

# ── Configuration ────────────────────────────────────────────────────────────

DEPLOY_HOST="${DEPLOY_HOST:?Set DEPLOY_HOST to your server IP or hostname}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_KEY="${DEPLOY_KEY:-}"

IMAGE_REPO="${IMAGE_REPO:-ghcr.io/frak-id/atelier-manager}"
IMAGE_TAG="${IMAGE_TAG:-dev-$(git rev-parse --short HEAD)}"

RELEASE_NAME="${RELEASE_NAME:-atelier}"
NAMESPACE="${NAMESPACE:-atelier-system}"

VALUES_FILE="${VALUES_FILE:-}"
HELM_SET="${HELM_SET:-}"
SKIP_BUILD="${SKIP_BUILD:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REMOTE_DIR="/tmp/atelier-helm-deploy"
IMAGE="${IMAGE_REPO}:${IMAGE_TAG}"

# ── Helpers ──────────────────────────────────────────────────────────────────

ssh_opts=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
[[ -n "$DEPLOY_KEY" ]] && ssh_opts+=(-i "$DEPLOY_KEY")

remote() { ssh "${ssh_opts[@]}" "${DEPLOY_USER}@${DEPLOY_HOST}" "$@"; }
info()   { printf "\n\033[1;34m==> %s\033[0m\n" "$*"; }
ok()     { printf "\033[1;32m    ✓ %s\033[0m\n" "$*"; }
warn()   { printf "\033[1;33m    ⚠ %s\033[0m\n" "$*"; }
err()    { printf "\033[1;31m    ✗ %s\033[0m\n" "$*" >&2; }

# ── Preflight ────────────────────────────────────────────────────────────────

info "Preflight checks"

if [[ -z "$SKIP_BUILD" ]]; then
  command -v docker >/dev/null 2>&1 || { err "docker is required"; exit 1; }
  ok "docker"
fi

command -v rsync >/dev/null 2>&1 || { err "rsync is required"; exit 1; }
ok "rsync"

remote "true" 2>/dev/null || { err "Cannot SSH to ${DEPLOY_USER}@${DEPLOY_HOST}"; exit 1; }
ok "ssh → ${DEPLOY_USER}@${DEPLOY_HOST}"

remote "command -v helm >/dev/null 2>&1" || { err "helm not found on server"; exit 1; }
ok "helm on server"

remote "command -v kubectl >/dev/null 2>&1" || { err "kubectl not found on server"; exit 1; }
ok "kubectl on server"

# ── Step 1: Build Docker image ───────────────────────────────────────────────

if [[ -z "$SKIP_BUILD" ]]; then
  info "Building image: ${IMAGE} (linux/amd64)"

  if docker buildx version >/dev/null 2>&1; then
    docker buildx build \
      --platform linux/amd64 \
      -t "${IMAGE}" \
      --load \
      "${REPO_ROOT}"
  else
    warn "docker buildx not available, using regular build (host must be amd64)"
    docker build -t "${IMAGE}" "${REPO_ROOT}"
  fi

  ok "Image built"

  # ── Step 2: Push to GHCR ─────────────────────────────────────────────────

  info "Pushing to GHCR"

  # Verify GHCR auth
  if ! docker push "${IMAGE}" 2>/dev/null; then
    err "docker push failed — are you logged into GHCR?"
    echo ""
    echo "    Run: echo \$GITHUB_TOKEN | docker login ghcr.io -u YOUR_USERNAME --password-stdin"
    echo ""
    exit 1
  fi

  ok "Pushed ${IMAGE}"

  # ── Step 3: Import into k3s containerd ───────────────────────────────────

  info "Importing image into k3s containerd (avoids GHCR pull auth on server)"

  docker save "${IMAGE}" | remote 'k3s ctr -n k8s.io images import -'

  ok "Image imported into k3s"
else
  info "Skipping image build (SKIP_BUILD=1)"
fi

# ── Step 4: Copy Helm chart ─────────────────────────────────────────────────

info "Syncing Helm chart to ${DEPLOY_HOST}:${REMOTE_DIR}"

remote "mkdir -p ${REMOTE_DIR}"

rsync -az --delete \
  -e "ssh ${ssh_opts[*]}" \
  "${REPO_ROOT}/charts/atelier/" \
  "${DEPLOY_USER}@${DEPLOY_HOST}:${REMOTE_DIR}/atelier/"

ok "Chart synced"

if [[ -n "$VALUES_FILE" && -f "$VALUES_FILE" ]]; then
  rsync -az \
    -e "ssh ${ssh_opts[*]}" \
    "$VALUES_FILE" \
    "${DEPLOY_USER}@${DEPLOY_HOST}:${REMOTE_DIR}/values-override.yaml"
  ok "Values file copied: ${VALUES_FILE}"
fi

# ── Step 5: Helm deploy ─────────────────────────────────────────────────────

info "Running helm upgrade --install"

HELM_CMD="helm upgrade --install ${RELEASE_NAME} ${REMOTE_DIR}/atelier"
HELM_CMD+=" --namespace ${NAMESPACE} --create-namespace"
HELM_CMD+=" --set manager.image.tag=${IMAGE_TAG}"

# Use values override file if provided
if [[ -n "$VALUES_FILE" ]]; then
  HELM_CMD+=" --values ${REMOTE_DIR}/values-override.yaml"
fi

# Append extra --set flags
if [[ -n "$HELM_SET" ]]; then
  HELM_CMD+=" ${HELM_SET}"
fi

echo "    $ ${HELM_CMD}"
remote "${HELM_CMD}"

ok "Helm release deployed"

# ── Step 6: Wait and verify ─────────────────────────────────────────────────

info "Waiting for rollout"

if ! remote "kubectl -n ${NAMESPACE} rollout status deployment/${RELEASE_NAME}-atelier-manager --timeout=120s"; then
  warn "Rollout didn't complete in time — dumping diagnostics"
  echo ""
  remote "kubectl -n ${NAMESPACE} get pods -l app.kubernetes.io/component=manager" || true
  echo ""
  remote "kubectl -n ${NAMESPACE} describe pod -l app.kubernetes.io/component=manager" | tail -40 || true
  echo ""
  remote "kubectl -n ${NAMESPACE} logs -l app.kubernetes.io/component=manager --tail=50" || true
  exit 1
fi

ok "Manager pod is running"

echo ""
remote "kubectl -n ${NAMESPACE} get pods"

# ── Done ─────────────────────────────────────────────────────────────────────

SVC_NAME="${RELEASE_NAME}-atelier-manager"

info "Deployment complete!"
echo ""
echo "  ┌─ VPC testing ──────────────────────────────────────────────────────┐"
echo "  │                                                                    │"
echo "  │  # Start port-forward (use 4001 to avoid conflict with FC on 4000)│"
echo "  │  ssh ${DEPLOY_USER}@${DEPLOY_HOST} \\                             │"
echo "  │    'kubectl -n ${NAMESPACE} port-forward \\                       │"
echo "  │     svc/${SVC_NAME} 4001:4000 --address=0.0.0.0 &'               │"
echo "  │                                                                    │"
echo "  │  # Health checks (from VPC)                                        │"
echo "  │  curl http://${DEPLOY_HOST}:4001/health/ready                      │"
echo "  │  curl http://${DEPLOY_HOST}:4001/health/live                       │"
echo "  │                                                                    │"
echo "  │  # Logs                                                            │"
echo "  │  ssh ${DEPLOY_USER}@${DEPLOY_HOST} \\                             │"
echo "  │    'kubectl -n ${NAMESPACE} logs -f deploy/${SVC_NAME}'            │"
echo "  │                                                                    │"
echo "  │  # Rollback (removes k8s deployment, FC untouched)                 │"
echo "  │  ssh ${DEPLOY_USER}@${DEPLOY_HOST} \\                             │"
echo "  │    'helm uninstall ${RELEASE_NAME} -n ${NAMESPACE}'                │"
echo "  │                                                                    │"
echo "  └───────────────────────────────────────────────────────────────────-┘"
echo ""
