#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# buildkit-tunnel.sh — Tunnel local Docker Buildx to remote BuildKit in K8s
#
# Usage:
#   # Port-forward mode (requires kubectl):
#   ./scripts/buildkit-tunnel.sh
#
#   # SSH mode:
#   SSH_HOST=my-server.com ./scripts/buildkit-tunnel.sh --mode ssh
#
#   # Custom port:
#   LOCAL_PORT=9999 ./scripts/buildkit-tunnel.sh
#
#   # Teardown (remove buildx builder):
#   ./scripts/buildkit-tunnel.sh --teardown
# ─────────────────────────────────────────────────────────────────────────────

# ── Configuration ────────────────────────────────────────────────────────────

MODE="port-forward"
TEARDOWN=""
STATUS_ONLY=""

NAMESPACE="${NAMESPACE:-atelier-system}"
RELEASE_NAME="${RELEASE_NAME:-atelier}"
LOCAL_PORT="${LOCAL_PORT:-1234}"
BUILDKIT_PORT="${BUILDKIT_PORT:-1234}"
SSH_HOST="${SSH_HOST:-}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY_PATH="${SSH_KEY_PATH:-}"

CHART_NAME="atelier"
BUILDER_NAME="atelier-remote"
PID_FILE="/tmp/${BUILDER_NAME}-tunnel.pid"

# Replicate Helm's atelier.fullname logic: avoid "release-chartname" duplication
if [[ "${RELEASE_NAME}" == *"${CHART_NAME}"* ]]; then
  FULLNAME="${RELEASE_NAME}"
else
  FULLNAME="${RELEASE_NAME}-${CHART_NAME}"
fi
SERVICE_NAME="${FULLNAME}-buildkit"

# ── Helpers ──────────────────────────────────────────────────────────────────

info()   { printf "\n\033[1;34m==> %s\033[0m\n" "$*"; }
ok()     { printf "\033[1;32m    ✓ %s\033[0m\n" "$*"; }
warn()   { printf "\033[1;33m    ⚠ %s\033[0m\n" "$*"; }
err()    { printf "\033[1;31m    ✗ %s\033[0m\n" "$*" >&2; }

usage() {
  cat <<EOF
Usage: ./scripts/buildkit-tunnel.sh [--mode port-forward|ssh] [--status] [--teardown]

Options:
  --mode MODE     Tunnel mode: port-forward (default) or ssh
  --status        Show current tunnel and buildx builder status
  --teardown      Remove buildx builder and stop tunnel (if running)
  -h, --help      Show this help

Environment variables:
  NAMESPACE       Kubernetes namespace (default: atelier-system)
  RELEASE_NAME    Helm release name (default: atelier)
  LOCAL_PORT      Local tunnel port (default: 1234)
  BUILDKIT_PORT   BuildKit service port (default: 1234)
  SSH_HOST        Required in ssh mode
  SSH_USER        SSH user (default: root)
  SSH_KEY_PATH    Optional SSH private key path

Examples:
  ./scripts/buildkit-tunnel.sh
  SSH_HOST=my-server.com ./scripts/buildkit-tunnel.sh --mode ssh
  LOCAL_PORT=9999 ./scripts/buildkit-tunnel.sh
  ./scripts/buildkit-tunnel.sh --teardown
EOF
}

is_pid_running() {
  local pid="$1"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" >/dev/null 2>&1
}

local_port_open() {
  (echo >"/dev/tcp/127.0.0.1/${LOCAL_PORT}") >/dev/null 2>&1
}

wait_for_tunnel() {
  local attempts=30
  local i=1
  while [[ "$i" -le "$attempts" ]]; do
    if local_port_open; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

cleanup_pid_file() {
  if [[ -f "$PID_FILE" ]]; then
    rm -f "$PID_FILE"
  fi
}

stop_tunnel_if_running() {
  if [[ -f "$PID_FILE" ]]; then
    local existing_pid
    existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if is_pid_running "$existing_pid"; then
      info "Stopping existing tunnel (pid ${existing_pid})"
      kill "$existing_pid" >/dev/null 2>&1 || true
      sleep 1
      if is_pid_running "$existing_pid"; then
        kill -9 "$existing_pid" >/dev/null 2>&1 || true
      fi
      ok "Tunnel stopped"
    fi
    cleanup_pid_file
  fi
}

buildx_builder_exists() {
  docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1
}

ensure_buildx_builder() {
  info "Configuring docker buildx builder"
  if buildx_builder_exists; then
    docker buildx use "$BUILDER_NAME" >/dev/null 2>&1 || true
    ok "Using existing builder: ${BUILDER_NAME}"
  else
    docker buildx create \
      --name "$BUILDER_NAME" \
      --driver remote \
      --use \
      "tcp://localhost:${LOCAL_PORT}" >/dev/null
    ok "Created builder: ${BUILDER_NAME}"
  fi

  if docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
    ok "Builder health check passed"
  else
    err "Builder health check failed"
    exit 1
  fi
}

status() {
  info "Status"
  echo "  Mode:        ${MODE}"
  echo "  Namespace:   ${NAMESPACE}"
  echo "  Service:     ${SERVICE_NAME}"
  echo "  Local port:  ${LOCAL_PORT}"

  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if is_pid_running "$pid"; then
      ok "Tunnel process running (pid ${pid})"
    else
      warn "Stale tunnel pid file found"
    fi
  else
    warn "No tunnel pid file"
  fi

  if local_port_open; then
    ok "Local tunnel endpoint reachable: tcp://localhost:${LOCAL_PORT}"
  else
    warn "Local tunnel endpoint not reachable: tcp://localhost:${LOCAL_PORT}"
  fi

  if buildx_builder_exists; then
    ok "Buildx builder exists: ${BUILDER_NAME}"
    if docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
      ok "Buildx builder is inspectable"
    else
      warn "Buildx builder exists but inspect failed"
    fi
  else
    warn "Buildx builder not found: ${BUILDER_NAME}"
  fi
}

# ── Argument parsing ──────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || { err "--mode requires a value"; exit 1; }
      MODE="$2"
      shift 2
      ;;
    --teardown)
      TEARDOWN="1"
      shift
      ;;
    --status)
      STATUS_ONLY="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      err "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ "$MODE" != "port-forward" && "$MODE" != "ssh" ]]; then
  err "Invalid --mode value: ${MODE} (expected: port-forward|ssh)"
  exit 1
fi

# ── Teardown / status ────────────────────────────────────────────────────────

if [[ -n "$TEARDOWN" ]]; then
  info "Teardown"
  stop_tunnel_if_running
  if buildx_builder_exists; then
    docker buildx rm "$BUILDER_NAME" >/dev/null
    ok "Removed buildx builder: ${BUILDER_NAME}"
  else
    warn "Buildx builder does not exist: ${BUILDER_NAME}"
  fi
  ok "Teardown complete"
  exit 0
fi

if [[ -n "$STATUS_ONLY" ]]; then
  status
  exit 0
fi

# ── Preflight ────────────────────────────────────────────────────────────────

info "Preflight checks"

command -v docker >/dev/null 2>&1 || { err "docker is required"; exit 1; }
ok "docker"

if docker buildx version >/dev/null 2>&1; then
  ok "docker buildx"
else
  err "docker buildx is required"
  exit 1
fi

if [[ "$MODE" == "port-forward" ]]; then
  command -v kubectl >/dev/null 2>&1 || { err "kubectl is required in port-forward mode"; exit 1; }
  ok "kubectl"

  kubectl get svc -n "$NAMESPACE" "$SERVICE_NAME" >/dev/null 2>&1 \
    || { err "Cannot access service ${SERVICE_NAME} in namespace ${NAMESPACE}"; exit 1; }
  ok "service ${SERVICE_NAME}"
else
  command -v ssh >/dev/null 2>&1 || { err "ssh is required in ssh mode"; exit 1; }
  ok "ssh"

  [[ -n "$SSH_HOST" ]] || { err "SSH_HOST is required in ssh mode"; exit 1; }
  ok "SSH_HOST=${SSH_HOST}"
fi

# ── Tunnel setup ─────────────────────────────────────────────────────────────

TUNNEL_PID=""

cleanup() {
  if [[ -n "${TUNNEL_PID}" ]] && is_pid_running "$TUNNEL_PID"; then
    info "Stopping tunnel"
    kill "$TUNNEL_PID" >/dev/null 2>&1 || true
    sleep 1
    if is_pid_running "$TUNNEL_PID"; then
      kill -9 "$TUNNEL_PID" >/dev/null 2>&1 || true
    fi
    ok "Tunnel stopped"
  fi
  cleanup_pid_file
}

trap cleanup EXIT INT TERM

stop_tunnel_if_running

if [[ "$MODE" == "port-forward" ]]; then
  info "Starting kubectl port-forward"
  kubectl port-forward -n "$NAMESPACE" "svc/$SERVICE_NAME" \
    "${LOCAL_PORT}:${BUILDKIT_PORT}" >/dev/null 2>&1 &
  TUNNEL_PID="$!"
  printf "%s" "$TUNNEL_PID" > "$PID_FILE"
  ok "kubectl tunnel pid ${TUNNEL_PID}"
else
  info "Resolving BuildKit service ClusterIP via SSH"

  SSH_CMD="ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
  if [[ -n "$SSH_KEY_PATH" ]]; then
    SSH_CMD+=" -i ${SSH_KEY_PATH}"
  fi

  SERVICE_IP="$($SSH_CMD "${SSH_USER}@${SSH_HOST}" \
    "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml && kubectl get svc -n ${NAMESPACE} ${SERVICE_NAME} -o jsonpath='{.spec.clusterIP}'" 2>/dev/null || true)"

  [[ -n "$SERVICE_IP" ]] || { err "Failed to resolve ClusterIP for ${SERVICE_NAME}"; exit 1; }
  ok "BuildKit ClusterIP: ${SERVICE_IP}"

  info "Starting SSH tunnel"
  $SSH_CMD -N -L "${LOCAL_PORT}:${SERVICE_IP}:${BUILDKIT_PORT}" \
    "${SSH_USER}@${SSH_HOST}" >/dev/null 2>&1 &
  TUNNEL_PID="$!"
  printf "%s" "$TUNNEL_PID" > "$PID_FILE"
  ok "ssh tunnel pid ${TUNNEL_PID}"
fi

if ! wait_for_tunnel; then
  err "Tunnel did not become ready on localhost:${LOCAL_PORT}"
  exit 1
fi
ok "Tunnel ready: tcp://localhost:${LOCAL_PORT}"

# ── Buildx setup and health check ────────────────────────────────────────────

ensure_buildx_builder

# ── Done ─────────────────────────────────────────────────────────────────────

info "BuildKit tunnel is active"
echo ""
echo "  Builder:  ${BUILDER_NAME}"
echo "  Endpoint: tcp://localhost:${LOCAL_PORT}"
echo ""
echo "  Build command:"
echo "    docker buildx build --builder ${BUILDER_NAME} --platform linux/amd64 ."
echo ""
echo "  Load image locally for testing:"
echo "    docker buildx build --builder ${BUILDER_NAME} --platform linux/amd64 --load ."
echo ""
echo "Press Ctrl-C to stop the tunnel (builder remains configured)."

wait "$TUNNEL_PID"
