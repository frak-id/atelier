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
#
# Deploys the shared cluster-infra chart (Zot, CLIProxy, sshpiper, cert-manager
# issuers, kata runtimeclass, snapshot class). The v2 server + console app is
# deployed separately via infra/k8s/v2. Only the sandbox agent image is built
# here (baked into base images); the chart itself pulls upstream infra images.
# ─────────────────────────────────────────────────────────────────────────────

# ── Configuration ────────────────────────────────────────────────────────────

source .env

SSH_HOST="${SSH_HOST:?Set SSH_HOST to your server IP or hostname}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY_PATH="${SSH_KEY_PATH:-}"
SSH_KEY_PASSPHRASE="${SSH_KEY_PASSPHRASE:-}"

AGENT_IMAGE_REPO="${AGENT_IMAGE_REPO:-ghcr.io/frak-id/sandbox-agent}"
RELEASE_NAME="${RELEASE_NAME:-atelier}"
NAMESPACE="${NAMESPACE:-atelier-system}"
CHART_NAME="atelier"

VALUES_FILE="${VALUES_FILE:-}"
HELM_SET="${HELM_SET:-}"
SKIP_BUILD="${SKIP_BUILD:-}"

# When skipping build, default to the nightly GHCR image
if [[ -z "${IMAGE_TAG:-}" ]]; then
  if [[ -n "${SKIP_BUILD}" ]]; then
    IMAGE_TAG="nightly"
  else
    IMAGE_TAG="dev-$(git rev-parse --short HEAD)"
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REMOTE_DIR="/tmp/atelier-helm-deploy"
AGENT_IMAGE="${AGENT_IMAGE_REPO}:${IMAGE_TAG}"

# Replicate Helm's atelier.fullname logic: avoid "release-chartname" duplication
if [[ "${RELEASE_NAME}" == *"${CHART_NAME}"* ]]; then
  FULLNAME="${RELEASE_NAME}"
else
  FULLNAME="${RELEASE_NAME}-${CHART_NAME}"
fi

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

if [[ -z "$SKIP_BUILD" ]]; then
  # Sandbox agent (apps/agent-v2, `atelier-agent`). Self-building multi-stage
  # image — no prebuilt binary needed.
  info "Building agent: ${AGENT_IMAGE} (linux/amd64)"
  if docker buildx version >/dev/null 2>&1; then
    docker buildx build \
      --platform linux/amd64 \
      -t "${AGENT_IMAGE}" \
      --load \
      -f "${REPO_ROOT}/apps/agent-v2/Dockerfile" \
      "${REPO_ROOT}/apps/agent-v2"
  else
    docker build -t "${AGENT_IMAGE}" -f "${REPO_ROOT}/apps/agent-v2/Dockerfile" "${REPO_ROOT}/apps/agent-v2"
  fi
  ok "Agent image built"

  # ── Step 2: Push to GHCR ─────────────────────────────────────────────────

  info "Pushing to GHCR"

  docker push "${AGENT_IMAGE}" 2>/dev/null || warn "Could not push agent image to GHCR (non-fatal)"
  ok "Pushed ${AGENT_IMAGE}"

  # ── Step 3: Import into k3s containerd ───────────────────────────────────

  info "Importing images into k3s containerd"

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

if [[ -n "$VALUES_FILE" ]]; then
  HELM_CMD+=" --values ${REMOTE_DIR}/values-override.yaml"
fi

if [[ -n "$HELM_SET" ]]; then
  HELM_CMD+=" ${HELM_SET}"
fi

echo "    $ ${HELM_CMD}"
remote "${HELM_CMD}"

ok "Helm release deployed"

# ── Step 6: Configure k3s registries for the OCI registry ──────────────────
#
# The chart deploys a bundled Zot as `${FULLNAME}-zot`. Override
# REGISTRY_HOST_PORT for an external registry (zot.externalUrl in values).

info "Configuring k3s registries"

REGISTRY_HOST_PORT="${REGISTRY_HOST_PORT:-${FULLNAME}-zot.${NAMESPACE}.svc:5000}"

if [[ -z "$REGISTRY_HOST_PORT" ]]; then
  warn "No registry host resolved — skipping registries config"
else
  REGISTRY_HOST="${REGISTRY_HOST_PORT%:*}"
  REGISTRY_PORT="${REGISTRY_HOST_PORT##*:}"
  # Expect host of the form `<svc>.<ns>.svc`. Anything else (e.g. an FQDN
  # outside the cluster) is left alone — the user is responsible for DNS.
  if [[ "$REGISTRY_HOST" == *.*.svc ]]; then
    REGISTRY_SVC="${REGISTRY_HOST%%.*}"
    REGISTRY_NS="${REGISTRY_HOST#*.}"; REGISTRY_NS="${REGISTRY_NS%.svc}"
    REGISTRY_IP=$(remote "kubectl get svc -n ${REGISTRY_NS} ${REGISTRY_SVC} -o jsonpath='{.spec.clusterIP}' 2>/dev/null" || echo "")
  else
    REGISTRY_IP=""
  fi

  if [[ -z "$REGISTRY_IP" ]]; then
    warn "Could not resolve ClusterIP for ${REGISTRY_HOST_PORT} — skipping registries config"
    warn "Configure /etc/rancher/k3s/registries.yaml manually if you use an out-of-cluster registry."
  else
    NEW_REGISTRIES="mirrors:
  \"${REGISTRY_HOST_PORT}\":
    endpoint:
      - \"http://${REGISTRY_IP}:${REGISTRY_PORT}\""

    CURRENT_REGISTRIES=$(remote "cat /etc/rancher/k3s/registries.yaml 2>/dev/null" || echo "")

    if [[ "$NEW_REGISTRIES" != "$CURRENT_REGISTRIES" ]]; then
      remote "cat > /etc/rancher/k3s/registries.yaml << REGEOF
mirrors:
  \"${REGISTRY_HOST_PORT}\":
    endpoint:
      - \"http://${REGISTRY_IP}:${REGISTRY_PORT}\"
REGEOF"
      ok "registries.yaml updated (${REGISTRY_HOST_PORT} → ${REGISTRY_IP}:${REGISTRY_PORT})"

      info "Restarting k3s to apply registries config"
      remote "systemctl restart k3s"
      sleep 15
      ok "k3s restarted"
    else
      ok "registries.yaml already up to date"
    fi
  fi
fi

# ── Step 7: Verify ──────────────────────────────────────────────────────────

info "Deployed resources"
remote "kubectl -n ${NAMESPACE} get pods" || true

# ── Step 8: Sync agent image to the OCI registry ───────────────────────

info "Syncing agent image to registry"
if [[ -n "${REGISTRY_IP:-}" ]]; then
  if [[ -n "$SKIP_BUILD" ]]; then
    # GHCR images from buildx contain a multi-platform OCI index with attestation
    # manifests that containerd cannot push to Zot. Use crane for single-platform copy.
    remote "command -v crane >/dev/null 2>&1 || \
      (curl -sL 'https://github.com/google/go-containerregistry/releases/latest/download/go-containerregistry_Linux_x86_64.tar.gz' \
        | tar xzf - -C /usr/local/bin crane)"
    remote "crane copy --platform linux/amd64 --insecure ${AGENT_IMAGE} ${REGISTRY_IP}:${REGISTRY_PORT}/sandbox-agent:latest" \
      && ok "Agent image synced to registry" \
      || warn "Could not sync agent image (non-fatal)"
  else
    remote "k3s ctr -n k8s.io images tag ${AGENT_IMAGE} ${REGISTRY_IP}:${REGISTRY_PORT}/sandbox-agent:latest 2>/dev/null || true"
    remote "k3s ctr -n k8s.io images push --plain-http ${REGISTRY_IP}:${REGISTRY_PORT}/sandbox-agent:latest 2>&1" \
      && ok "Agent image pushed to registry" \
      || warn "Could not push agent image (non-fatal)"
  fi
else
  warn "Registry ClusterIP not resolved — skipping agent sync"
fi

# ── Done ─────────────────────────────────────────────────────────────────────

info "Deployment complete!"
echo ""
echo "  This deploys the shared cluster-infra chart. The v2 server + console app"
echo "  is deployed separately via infra/k8s/v2 (see infra/k8s/v2/README.md)."
echo ""
echo "  Pods:      kubectl -n ${NAMESPACE} get pods"
echo ""
echo "  Rollback:  helm uninstall ${RELEASE_NAME} -n ${NAMESPACE}"
echo ""
