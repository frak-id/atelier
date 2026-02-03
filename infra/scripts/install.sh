#!/usr/bin/env bash
set -euo pipefail

REPO="${FRAK_REPO:-frak-id/oc-sandbox}"
VERSION="${FRAK_VERSION:-}"
CLI_NAME="frak-sandbox"
CLI_PATH="/usr/local/bin/${CLI_NAME}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo -s)." >&2
  exit 1
fi

if [ -f /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if [ "${ID:-}" != "debian" ]; then
    echo "Unsupported distro: ${ID:-unknown}. Debian required." >&2
    exit 1
  fi
else
  echo "/etc/os-release not found. Cannot verify distro." >&2
  exit 1
fi

ARCH="$(uname -m)"
if [ "$ARCH" != "x86_64" ]; then
  echo "Unsupported architecture: $ARCH (x86_64 required)." >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is required (systemctl not found)." >&2
  exit 1
fi

if [ ! -c /dev/kvm ]; then
  echo "/dev/kvm not found. Ensure KVM is enabled and this is bare metal." >&2
  exit 1
fi

echo "Installing prerequisites..."
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates sudo jq

if [ -z "$VERSION" ]; then
  echo "Fetching latest release..."
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | jq -r '.tag_name')"
fi

if [ -z "$VERSION" ] || [ "$VERSION" = "null" ]; then
  echo "Could not determine release version." >&2
  exit 1
fi

CLI_URL="https://github.com/${REPO}/releases/download/${VERSION}/frak-sandbox-linux-x64"

echo "Downloading CLI ${VERSION}..."
curl -fsSL "$CLI_URL" -o "$CLI_PATH"
chmod +x "$CLI_PATH"

if ! getent group kvm >/dev/null 2>&1; then
  groupadd kvm
fi

if ! id frak >/dev/null 2>&1; then
  useradd --system --create-home --shell /bin/bash frak
fi
usermod -aG kvm frak

mkdir -p /var/lib/sandbox /var/log/sandbox /opt/frak-sandbox /etc/frak-sandbox
chown -R frak:frak /var/lib/sandbox /var/log/sandbox /opt/frak-sandbox
chgrp -R frak /etc/frak-sandbox
chmod 750 /etc/frak-sandbox

prompt() {
  local message="$1"
  local default="$2"
  local input
  read -r -p "${message} [${default}]: " input
  if [ -z "$input" ]; then
    echo "$default"
  else
    echo "$input"
  fi
}

echo ""
echo "=== Configuration ==="
DOMAIN_SUFFIX="$(prompt "Domain suffix" "example.com")"
API_DOMAIN="$(prompt "API domain" "sandbox-api.${DOMAIN_SUFFIX}")"
DASH_DOMAIN="$(prompt "Dashboard domain" "sandbox-dash.${DOMAIN_SUFFIX}")"
SSH_DOMAIN="$(prompt "SSH proxy domain" "ssh.${DOMAIN_SUFFIX}")"
TLS_EMAIL="$(prompt "TLS email" "admin@${DOMAIN_SUFFIX}")"

GITHUB_CLIENT_ID="$(prompt "GitHub Client ID" "")"
GITHUB_CLIENT_SECRET="$(prompt "GitHub Client Secret" "")"
ALLOWED_ORG="$(prompt "Allowed GitHub org (optional)" "")"
ALLOWED_USERS="$(prompt "Allowed GitHub users (comma-separated, optional)" "")"
DEFAULT_JWT="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
JWT_SECRET="$(prompt "JWT secret" "$DEFAULT_JWT")"

ALLOWED_USERS_JSON="$(printf '%s' "$ALLOWED_USERS" | jq -R 'split(",") | map(gsub("^\\s+|\\s+$";"")) | map(select(length>0))')"

CONFIG_PATH="/etc/frak-sandbox/sandbox.config.json"

jq -n \
  --arg api "$API_DOMAIN" \
  --arg dash "$DASH_DOMAIN" \
  --arg suffix "$DOMAIN_SUFFIX" \
  --arg ssh "$SSH_DOMAIN" \
  --arg clientId "$GITHUB_CLIENT_ID" \
  --arg clientSecret "$GITHUB_CLIENT_SECRET" \
  --arg loginCb "https://${API_DOMAIN}/auth/callback" \
  --arg ghCb "https://${API_DOMAIN}/github/callback" \
  --arg jwt "$JWT_SECRET" \
  --arg allowedOrg "$ALLOWED_ORG" \
  --arg tlsEmail "$TLS_EMAIL" \
  --argjson allowedUsers "$ALLOWED_USERS_JSON" \
  '{
    domains: {
      api: $api,
      dashboard: $dash,
      sandboxSuffix: $suffix,
      ssh: $ssh
    },
    network: {
      bridgeName: "br0",
      bridgeIp: "172.16.0.1",
      bridgeCidr: "172.16.0.0/24",
      bridgeNetmask: "24",
      guestSubnet: "172.16.0",
      guestIpStart: 10,
      dnsServers: ["8.8.8.8", "8.8.4.4"]
    },
    auth: {
      githubClientId: $clientId,
      githubClientSecret: $clientSecret,
      githubCallbackUrl: $ghCb,
      githubLoginCallbackUrl: $loginCb,
      jwtSecret: $jwt,
      allowedOrg: $allowedOrg,
      allowedUsers: $allowedUsers
    },
    sshProxy: {
      port: 2222,
      domain: $ssh,
      pipesFile: "/var/lib/sandbox/sshpiper/pipes.yaml"
    },
    runtime: {
      mode: "production",
      port: 4000,
      host: "0.0.0.0"
    },
    tls: {
      email: $tlsEmail,
      certPath: "",
      keyPath: ""
    },
    services: {
      vscode: { port: 8080 },
      opencode: { port: 3000 },
      terminal: { port: 7681 },
      browser: { port: 6080 },
      agent: { port: 9999 }
    }
  }' > "$CONFIG_PATH"

chown root:frak "$CONFIG_PATH"
chmod 640 "$CONFIG_PATH"

echo ""
echo "Running setup..."
frak-sandbox setup
frak-sandbox update

read -r -p "Build base image now? (y/N): " BUILD_IMAGE
if [ "${BUILD_IMAGE:-N}" = "y" ] || [ "${BUILD_IMAGE:-N}" = "Y" ]; then
  frak-sandbox images build dev-base
fi

echo ""
echo "Install complete."
