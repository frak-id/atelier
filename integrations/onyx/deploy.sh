#!/usr/bin/env bash
#
# Deploy Onyx (company knowledge platform) to the hetzner-atelier k3s cluster.
#
# Creates/updates the chart-required secrets from env vars, then
# `helm upgrade --install` with the pinned chart version and helm/values.yaml.
#
# Usage:
#   integrations/onyx/deploy.sh              # create secrets, install/upgrade, wait for rollout
#   integrations/onyx/deploy.sh --dry-run     # helm template only, no secrets/cluster writes
#
# Required env vars (see README "Setup" for how to generate each):
#   ONYX_POSTGRES_PASSWORD    ONYX_REDIS_PASSWORD
#   ONYX_MINIO_ROOT_USER      ONYX_MINIO_ROOT_PASSWORD
#   ONYX_OPENSEARCH_ADMIN_PASSWORD
#   ONYX_USER_AUTH_SECRET     (openssl rand -hex 32)
#
set -euo pipefail

CTX="${KUBE_CONTEXT:-hetzner-atelier}"
NS="onyx"
RELEASE="onyx"
CHART_VERSION="0.8.38" # keep in lockstep with helm/values.yaml global.version

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

K() { kubectl --context "$CTX" "$@"; }
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

require_env() {
  local missing=()
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then missing+=("$name"); fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    echo "Missing required env vars: ${missing[*]}" >&2
    echo "See integrations/onyx/README.md 'Setup' for how to generate each." >&2
    exit 1
  fi
}

if $DRY_RUN; then
  say "Dry run: helm template only (no secrets, no cluster writes)"
  helm repo add onyx https://onyx-dot-app.github.io/onyx >/dev/null 2>&1 || true
  helm repo update onyx >/dev/null
  helm template "$RELEASE" onyx/onyx \
    --version "$CHART_VERSION" -n "$NS" \
    -f helm/values.yaml \
    --set auth.postgresql.values.password=dummy-postgres-password \
    --set auth.redis.values.redis_password=dummy-redis-password \
    --set auth.objectstorage.values.s3_aws_access_key_id=dummy-minio-user \
    --set auth.objectstorage.values.s3_aws_secret_access_key=dummy-minio-password \
    --set auth.objectstorage.values.rootUser=dummy-minio-user \
    --set auth.objectstorage.values.rootPassword=dummy-minio-password \
    --set auth.opensearch.values.opensearch_admin_password=Dummy-Passw0rd! \
    --set auth.userauth.values.user_auth_secret="$(printf 'a%.0s' {1..64})" \
    --set auth.postgresql.existingSecret= \
    --set auth.redis.existingSecret= \
    --set auth.objectstorage.existingSecret= \
    --set auth.opensearch.existingSecret= \
    --set auth.userauth.existingSecret=
  exit 0
fi

require_env \
  ONYX_POSTGRES_PASSWORD ONYX_REDIS_PASSWORD \
  ONYX_MINIO_ROOT_USER ONYX_MINIO_ROOT_PASSWORD \
  ONYX_OPENSEARCH_ADMIN_PASSWORD ONYX_USER_AUTH_SECRET

say "Creating namespace $NS"
K create namespace "$NS" --dry-run=client -o yaml | K apply -f -

say "Creating/updating chart secrets in $NS"
K -n "$NS" create secret generic onyx-postgresql \
  --from-literal=username=postgres \
  --from-literal=password="$ONYX_POSTGRES_PASSWORD" \
  --dry-run=client -o yaml | K apply -f -
K -n "$NS" create secret generic onyx-redis \
  --from-literal=redis_password="$ONYX_REDIS_PASSWORD" \
  --dry-run=client -o yaml | K apply -f -
K -n "$NS" create secret generic onyx-objectstorage \
  --from-literal=s3_aws_access_key_id="$ONYX_MINIO_ROOT_USER" \
  --from-literal=s3_aws_secret_access_key="$ONYX_MINIO_ROOT_PASSWORD" \
  --from-literal=rootUser="$ONYX_MINIO_ROOT_USER" \
  --from-literal=rootPassword="$ONYX_MINIO_ROOT_PASSWORD" \
  --dry-run=client -o yaml | K apply -f -
K -n "$NS" create secret generic onyx-opensearch \
  --from-literal=opensearch_admin_username=admin \
  --from-literal=opensearch_admin_password="$ONYX_OPENSEARCH_ADMIN_PASSWORD" \
  --dry-run=client -o yaml | K apply -f -
K -n "$NS" create secret generic onyx-userauth \
  --from-literal=user_auth_secret="$ONYX_USER_AUTH_SECRET" \
  --dry-run=client -o yaml | K apply -f -

say "helm repo add/update onyx"
helm repo add onyx https://onyx-dot-app.github.io/onyx >/dev/null 2>&1 || true
helm repo update onyx

say "helm upgrade --install $RELEASE onyx/onyx --version $CHART_VERSION"
helm --kube-context "$CTX" upgrade --install "$RELEASE" onyx/onyx \
  --version "$CHART_VERSION" -n "$NS" --create-namespace \
  -f helm/values.yaml

say "Waiting for api/webserver rollout"
K -n "$NS" rollout status "deploy/${RELEASE}-api" --timeout=300s
K -n "$NS" rollout status "deploy/${RELEASE}-webserver" --timeout=180s

say "Done"
K -n "$NS" get pods -o wide

cat <<'EOF'

Next steps:
  1. Visit https://onyx.hetzner-staging.frak.id and sign up the first user
     (this becomes the Onyx Admin automatically).
  2. Settings -> API Keys -> create a key in the Admin group. This is the
     bootstrap key Terraform authenticates with (ONYX_API_KEY below).
  3. cd integrations/onyx/terraform && cp terraform.tfvars.example terraform.tfvars
     (fill in onyx_api_key + whichever source secrets you have), then:
       terraform init && terraform apply
  4. See README.md "Setup" for per-source manual prerequisites (Slack app
     manifest, GitHub PAT scopes, Notion integration, Gmail domain-wide
     delegation) and the monthly Slack-window re-apply.
EOF
