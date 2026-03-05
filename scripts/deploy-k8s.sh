#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# deploy-k8s.sh — Build, push, and deploy Atelier to a remote k3s server
#
# Prerequisites on the server:
#   - k3s with helm
#   - cert-manager (helm install cert-manager jetstack/cert-manager ...)
#   - kata-deploy  (helm install kata-deploy kata-containers/kata-deploy)
#
# Usage:
#   VALUES_FILE=./values.production.yaml ./scripts/deploy-k8s.sh
#
#   # Skip image build (chart-only update):
#   SKIP_BUILD=1 VALUES_FILE=./values.production.yaml ./scripts/deploy-k8s.sh
#
#   # Restore a database backup after deploy:
#   DB_RESTORE_PATH=/root/manager.db VALUES_FILE=./values.production.yaml ./scripts/deploy-k8s.sh
# ─────────────────────────────────────────────────────────────────────────────

# ── Configuration ────────────────────────────────────────────────────────────

source .env

SSH_HOST="${SSH_HOST:?Set SSH_HOST to your server IP or hostname}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY_PATH="${SSH_KEY_PATH:-}"
SSH_KEY_PASSPHRASE="${SSH_KEY_PASSPHRASE:-}"

MANAGER_IMAGE_REPO="${IMAGE_REPO:-ghcr.io/frak-id/atelier-manager}"
DASHBOARD_IMAGE_REPO="${DASHBOARD_IMAGE_REPO:-ghcr.io/frak-id/atelier-dashboard}"
AGENT_IMAGE_REPO="${AGENT_IMAGE_REPO:-ghcr.io/frak-id/sandbox-agent}"
IMAGE_TAG="${IMAGE_TAG:-dev-$(git rev-parse --short HEAD)}"

RELEASE_NAME="${RELEASE_NAME:-atelier}"
NAMESPACE="${NAMESPACE:-atelier-system}"
CHART_NAME="atelier"
ZOT_PORT="${ZOT_PORT:-5000}"

VALUES_FILE="${VALUES_FILE:-}"
HELM_SET="${HELM_SET:-}"
SKIP_BUILD="${SKIP_BUILD:-}"
DB_RESTORE_PATH="${DB_RESTORE_PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REMOTE_DIR="/tmp/atelier-helm-deploy"
MANAGER_IMAGE="${MANAGER_IMAGE_REPO}:${IMAGE_TAG}"
DASHBOARD_IMAGE="${DASHBOARD_IMAGE_REPO}:${IMAGE_TAG}"
AGENT_IMAGE="${AGENT_IMAGE_REPO}:${IMAGE_TAG}"

# Replicate Helm's atelier.fullname logic: avoid "release-chartname" duplication
if [[ "${RELEASE_NAME}" == *"${CHART_NAME}"* ]]; then
  FULLNAME="${RELEASE_NAME}"
else
  FULLNAME="${RELEASE_NAME}-${CHART_NAME}"
fi
ZOT_SVC="${FULLNAME}-zot"

# ── SSH setup ────────────────────────────────────────────────────────────────

SSH_CONTROL_PATH="/tmp/ssh-atelier-deploy-%%r@%%h:%%p"
ssh_opts=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
ssh_opts+=(-o ControlMaster=auto -o "ControlPath=${SSH_CONTROL_PATH}" -o ControlPersist=120)
[[ -n "$SSH_KEY_PATH" ]] && ssh_opts+=(-i "$SSH_KEY_PATH")

if [[ -n "$SSH_KEY_PASSPHRASE" && -n "$SSH_KEY_PATH" ]]; then
  if [[ -z "${SSH_AUTH_SOCK:-}" ]]; then
    eval "$(ssh-agent -s)" >/dev/null
    trap 'ssh-agent -k >/dev/null 2>&1; ssh -o "ControlPath=${SSH_CONTROL_PATH}" -O exit "${SSH_USER}@${SSH_HOST}" 2>/dev/null' EXIT
  fi
  _askpass="$(mktemp)"
  printf '#!/bin/sh\necho "%s"\n' "$SSH_KEY_PASSPHRASE" > "$_askpass"
  chmod +x "$_askpass"
  SSH_ASKPASS="$_askpass" SSH_ASKPASS_REQUIRE=force ssh-add "$SSH_KEY_PATH" </dev/null 2>/dev/null \
    || DISPLAY=none SSH_ASKPASS="$_askpass" ssh-add "$SSH_KEY_PATH" </dev/null 2>/dev/null \
    || { err "Could not add SSH key to agent"; rm -f "$_askpass"; exit 1; }
  rm -f "$_askpass"
else
  trap 'ssh -o "ControlPath=${SSH_CONTROL_PATH}" -O exit "${SSH_USER}@${SSH_HOST}" 2>/dev/null' EXIT
fi

remote() { ssh "${ssh_opts[@]}" "${SSH_USER}@${SSH_HOST}" "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml && $*"; }

# ── Helpers ──────────────────────────────────────────────────────────────────
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

remote "true" 2>/dev/null || { err "Cannot SSH to ${SSH_USER}@${SSH_HOST}"; exit 1; }
ok "ssh → ${SSH_USER}@${SSH_HOST}"

remote "command -v helm >/dev/null 2>&1" || { err "helm not found on server"; exit 1; }
ok "helm on server"

remote "command -v kubectl >/dev/null 2>&1" || { err "kubectl not found on server"; exit 1; }
ok "kubectl on server"

# ── Prerequisites ────────────────────────────────────────────────────────────

info "Checking prerequisites"

remote "kubectl get crd certificates.cert-manager.io >/dev/null 2>&1" \
  || { err "cert-manager is not installed. Install it first:"; \
       echo "    helm repo add jetstack https://charts.jetstack.io"; \
       echo "    helm install cert-manager jetstack/cert-manager \\"; \
       echo "      --namespace cert-manager --create-namespace --set crds.enabled=true"; \
       exit 1; }
ok "cert-manager"

remote "kubectl get runtimeclass kata-clh >/dev/null 2>&1" \
  || { err "Kata Containers (kata-clh) not found. Install kata-deploy first:"; \
       echo "    git clone --depth 1 https://github.com/kata-containers/kata-containers.git /tmp/kata-src"; \
       echo "    helm install kata-deploy /tmp/kata-src/tools/packaging/kata-deploy/helm-chart/kata-deploy \\"; \
       echo "      --set k8sDistribution=k3s --set env.createRuntimeClasses=true --set env.createDefaultRuntimeClass=true"; \
       exit 1; }
ok "kata-clh RuntimeClass"

# Check for CSI snapshot controller (optional — prebuilds require it)
if remote "kubectl get crd volumesnapshots.snapshot.storage.k8s.io >/dev/null 2>&1"; then
  ok "CSI snapshot controller (prebuilds enabled)"
else
  warn "CSI snapshot controller not found — prebuilds will be disabled"
  warn "To enable prebuilds, install the CSI snapshot controller and a CSI driver (e.g., TopoLVM)"
fi

# ── Step 1: Build Docker images ──────────────────────────────────────────────

build_image() {
  local target="$1" image="$2"
  info "Building ${target}: ${image} (linux/amd64)"

  if docker buildx version >/dev/null 2>&1; then
    docker buildx build \
      --platform linux/amd64 \
      --target "${target}" \
      -t "${image}" \
      --load \
      "${REPO_ROOT}"
  else
    warn "docker buildx not available, using regular build (host must be amd64)"
    docker build --target "${target}" -t "${image}" "${REPO_ROOT}"
  fi

  ok "${target} image built"
}

if [[ -z "$SKIP_BUILD" ]]; then
  build_image manager "${MANAGER_IMAGE}"
  build_image dashboard "${DASHBOARD_IMAGE}"

  info "Building agent: ${AGENT_IMAGE} (linux/amd64)"
  if docker buildx version >/dev/null 2>&1; then
    docker buildx build \
      --platform linux/amd64 \
      -t "${AGENT_IMAGE}" \
      --load \
      -f "${REPO_ROOT}/apps/agent-rust/Dockerfile" \
      "${REPO_ROOT}/apps/agent-rust"
  else
    docker build -t "${AGENT_IMAGE}" -f "${REPO_ROOT}/apps/agent-rust/Dockerfile" "${REPO_ROOT}/apps/agent-rust"
  fi
  ok "Agent image built"

  # ── Step 2: Push to GHCR ─────────────────────────────────────────────────

  info "Pushing to GHCR"

  if ! docker push "${MANAGER_IMAGE}" 2>/dev/null; then
    err "docker push failed — are you logged into GHCR?"
    echo ""
    echo "    Run: echo \$GITHUB_TOKEN | docker login ghcr.io -u YOUR_USERNAME --password-stdin"
    echo ""
    exit 1
  fi
  ok "Pushed ${MANAGER_IMAGE}"

  if ! docker push "${DASHBOARD_IMAGE}" 2>/dev/null; then
    err "docker push failed for dashboard image"
    exit 1
  fi
  ok "Pushed ${DASHBOARD_IMAGE}"

  docker push "${AGENT_IMAGE}" 2>/dev/null || warn "Could not push agent image to GHCR (non-fatal)"
  ok "Pushed ${AGENT_IMAGE}"

  # ── Step 3: Import into k3s containerd ───────────────────────────────────

  info "Importing images into k3s containerd"

  docker save "${MANAGER_IMAGE}" | remote 'k3s ctr -n k8s.io images import -'
  ok "Manager image imported"

  docker save "${DASHBOARD_IMAGE}" | remote 'k3s ctr -n k8s.io images import -'
  ok "Dashboard image imported"

  docker save "${AGENT_IMAGE}" | remote 'k3s ctr -n k8s.io images import -'
  ok "Agent image imported"
else
  info "Skipping image build (SKIP_BUILD=1)"
fi

# ── Step 4: Copy Helm chart ─────────────────────────────────────────────────

info "Syncing Helm chart to ${SSH_HOST}:${REMOTE_DIR}"

remote "mkdir -p ${REMOTE_DIR}"

rsync -az --delete \
  -e "ssh ${ssh_opts[*]}" \
  "${REPO_ROOT}/charts/atelier/" \
  "${SSH_USER}@${SSH_HOST}:${REMOTE_DIR}/atelier/"

ok "Chart synced"

if [[ -n "$VALUES_FILE" && -f "$VALUES_FILE" ]]; then
  rsync -az \
    -e "ssh ${ssh_opts[*]}" \
    "$VALUES_FILE" \
    "${SSH_USER}@${SSH_HOST}:${REMOTE_DIR}/values-override.yaml"
  ok "Values file copied: ${VALUES_FILE}"
fi

# ── Step 5: Helm deploy ─────────────────────────────────────────────────────

info "Running helm upgrade --install"

HELM_CMD="helm upgrade --install ${RELEASE_NAME} ${REMOTE_DIR}/atelier"
HELM_CMD+=" --namespace ${NAMESPACE} --create-namespace"
HELM_CMD+=" --set manager.image.tag=${IMAGE_TAG}"
HELM_CMD+=" --set dashboard.image.tag=${IMAGE_TAG}"

if [[ -n "$VALUES_FILE" ]]; then
  HELM_CMD+=" --values ${REMOTE_DIR}/values-override.yaml"
fi

if [[ -n "$HELM_SET" ]]; then
  HELM_CMD+=" ${HELM_SET}"
fi

echo "    $ ${HELM_CMD}"
remote "${HELM_CMD}"

ok "Helm release deployed"

# ── Step 6: Configure k3s registries for Zot ────────────────────────────────

info "Configuring k3s registries for Zot"

ZOT_IP=$(remote "kubectl get svc -n ${NAMESPACE} ${ZOT_SVC} -o jsonpath='{.spec.clusterIP}' 2>/dev/null" || echo "")

if [[ -n "$ZOT_IP" ]]; then
  NEW_REGISTRIES="mirrors:
  \"${ZOT_SVC}.${NAMESPACE}.svc:${ZOT_PORT}\":
    endpoint:
      - \"http://${ZOT_IP}:${ZOT_PORT}\""

  CURRENT_REGISTRIES=$(remote "cat /etc/rancher/k3s/registries.yaml 2>/dev/null" || echo "")

  if [[ "$NEW_REGISTRIES" != "$CURRENT_REGISTRIES" ]]; then
    remote "cat > /etc/rancher/k3s/registries.yaml << REGEOF
mirrors:
  \"${ZOT_SVC}.${NAMESPACE}.svc:${ZOT_PORT}\":
    endpoint:
      - \"http://${ZOT_IP}:${ZOT_PORT}\"
REGEOF"
    ok "registries.yaml updated (Zot ClusterIP: ${ZOT_IP})"

    info "Restarting k3s to apply registries config"
    remote "systemctl restart k3s"
    sleep 15
    ok "k3s restarted"
  else
    ok "registries.yaml already up to date"
  fi
else
  warn "Zot service not found — skipping registries config"
fi

# ── Step 7: Wait and verify ─────────────────────────────────────────────────

info "Waiting for rollout"

if ! remote "kubectl -n ${NAMESPACE} rollout status deployment/${FULLNAME}-manager --timeout=120s"; then
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

# ── Step 8: Sync agent image to Zot ──────────────────────────────────────────

if [[ -z "$SKIP_BUILD" ]]; then
  info "Pushing agent image to Zot registry"
  if [[ -n "$ZOT_IP" ]]; then
    remote "k3s ctr -n k8s.io images tag ${AGENT_IMAGE} ${ZOT_IP}:${ZOT_PORT}/sandbox-agent:latest 2>/dev/null || true"
    remote "k3s ctr -n k8s.io images push --plain-http ${ZOT_IP}:${ZOT_PORT}/sandbox-agent:latest 2>&1" && ok "Agent image pushed to Zot" || warn "Could not push agent to Zot (non-fatal)"
  else
    warn "Zot service not found — skipping agent sync"
  fi
fi

# ── Step 9: Restore database backup (optional) ──────────────────────────────

if [[ -n "$DB_RESTORE_PATH" ]]; then
  info "Restoring database from ${DB_RESTORE_PATH}"

  MANAGER_POD=$(remote "kubectl -n ${NAMESPACE} get pod -l app.kubernetes.io/component=manager -o jsonpath='{.items[0].metadata.name}'")

  if [[ -n "$MANAGER_POD" ]]; then
    remote "kubectl cp ${DB_RESTORE_PATH} ${NAMESPACE}/${MANAGER_POD}:/app/data/manager.db -c manager"
    ok "Database copied to ${MANAGER_POD}:/app/data/manager.db"

    remote "kubectl -n ${NAMESPACE} rollout restart deployment/${FULLNAME}-manager"
    remote "kubectl -n ${NAMESPACE} rollout status deployment/${FULLNAME}-manager --timeout=60s"
    ok "Manager restarted with restored database"
  else
    warn "Could not find manager pod — skipping DB restore"
  fi
fi

# ── Done ─────────────────────────────────────────────────────────────────────

SVC_NAME="${FULLNAME}-manager"

info "Deployment complete!"
echo ""
echo "  Dashboard: https://sandbox.$(remote "kubectl -n ${NAMESPACE} get configmap ${FULLNAME}-manager-config -o jsonpath='{.data.sandbox\\.config\\.json}' 2>/dev/null" | grep -o '"baseDomain":"[^"]*"' | cut -d'"' -f4 || echo "your-domain.com")"
echo ""
echo "  Health:    kubectl -n ${NAMESPACE} port-forward svc/${SVC_NAME} 4000:4000"
echo "             curl http://127.0.0.1:4000/health/ready"
echo ""
echo "  Logs:      kubectl -n ${NAMESPACE} logs -f deploy/${SVC_NAME} -c manager"
echo ""
echo "  Rollback:  helm uninstall ${RELEASE_NAME} -n ${NAMESPACE}"
echo ""
